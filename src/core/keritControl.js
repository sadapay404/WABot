import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

async function runCommand(command, args, options) {
  const { stdout = '', stderr = '' } = await execFileAsync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return { stdout, stderr };
}

function shortHash(value) {
  return String(value || '').trim().slice(0, 7);
}

/**
 * Safe controls for Kerit/Pterodactyl source deployments.
 *
 * A game-panel container cannot reliably restart itself after a clean Node exit:
 * depending on the egg, the panel may leave it stopped. Consequently this class
 * can only fast-forward a clean Git checkout and install dependencies. It never
 * calls process.exit(), sends panel API requests, or alters the selected branch.
 */
export class KeritControl {
  constructor({ root, logger, env = process.env, run = runCommand }) {
    this.root = path.resolve(root);
    this.logger = logger.child({ scope: 'kerit-control' });
    this.env = env;
    this.run = run;
  }

  availability() {
    const host = String(this.env.NEXUS_HOST || this.env.NEXUS_DEPLOYMENT || '').trim().toLowerCase();
    if (!['kerit', 'pterodactyl'].includes(host)) {
      return {
        ok: false,
        reason: 'Kerit controls are off. Set NEXUS_HOST=kerit in the panel variables to enable safe update checks.',
      };
    }
    if (!fs.existsSync(path.join(this.root, 'package.json'))) {
      return { ok: false, reason: 'The Kerit application directory has no package.json.' };
    }
    if (!fs.statSync(path.join(this.root, '.git'), { throwIfNoEntry: false })?.isDirectory()) {
      return {
        ok: false,
        reason: 'This Kerit deployment is an uploaded archive, not a Git checkout. Use the panel’s reinstall/deploy flow; no files were changed.',
      };
    }
    return { ok: true, appDir: this.root, platform: 'kerit' };
  }

  async check() {
    const available = this.availability();
    if (!available.ok) return available;
    const options = { cwd: available.appDir, env: this.env, timeout: GIT_TIMEOUT_MS };

    try {
      const dirty = await this.run('git', ['status', '--porcelain'], options);
      if (dirty.stdout.trim()) {
        return {
          ok: false,
          reason: 'The deployment has local changes. They were left untouched; review them in the panel before updating.',
        };
      }

      const branch = (await this.run('git', ['branch', '--show-current'], options)).stdout.trim();
      const upstream = (await this.run(
        'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], options
      )).stdout.trim();
      if (!branch || !upstream) {
        return { ok: false, reason: 'This checkout has no GitHub upstream configured.' };
      }

      await this.run('git', ['fetch', '--prune'], options);
      const current = (await this.run('git', ['rev-parse', '--short', 'HEAD'], options)).stdout.trim();
      const remote = (await this.run('git', ['rev-parse', '--short', '@{u}'], options)).stdout.trim();
      const counts = (await this.run(
        'git', ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], options
      )).stdout.trim().split(/\s+/).map(Number);
      if (counts.length !== 2 || counts.some((count) => !Number.isSafeInteger(count))) {
        return { ok: false, reason: 'Git returned an unreadable ahead/behind count.' };
      }

      return {
        ok: true,
        appDir: available.appDir,
        platform: 'kerit',
        branch,
        upstream,
        current: shortHash(current),
        remote: shortHash(remote),
        ahead: counts[0],
        behind: counts[1],
      };
    } catch (error) {
      this.logger.warn(`Kerit update check failed: ${error.message}`);
      return { ok: false, reason: 'Could not check GitHub from the panel container. Check its network connection and try again.' };
    }
  }

  async update() {
    const status = await this.check();
    if (!status.ok) return status;
    if (status.ahead > 0) {
      return {
        ok: false,
        reason: 'This branch has local commits not on GitHub; automatic update stopped to avoid a merge or branch change.',
      };
    }
    if (status.behind === 0) return { ...status, updated: false, restartRequired: false };

    try {
      await this.run('git', ['pull', '--ff-only'], {
        cwd: status.appDir,
        env: this.env,
        timeout: GIT_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.warn(`Kerit fast-forward pull failed: ${error.message}`);
      return { ok: false, reason: 'Git could not fast-forward this branch; no reset or forced update was attempted.' };
    }

    try {
      await this.run('npm', ['ci', '--omit=optional', '--no-audit', '--fund=false'], {
        cwd: status.appDir,
        env: this.env,
        timeout: INSTALL_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.error(`Kerit dependency install failed: ${error.message}`);
      return {
        ok: false,
        reason: 'Code updated, but dependency installation failed. The current process was left running; restart only after fixing the install.',
      };
    }

    try {
      const current = (await this.run('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: status.appDir,
        env: this.env,
        timeout: GIT_TIMEOUT_MS,
      })).stdout.trim();
      return { ...status, current: shortHash(current), updated: true, restartRequired: true };
    } catch {
      return { ...status, updated: true, restartRequired: true };
    }
  }

  /** A container restart must be requested from the Kerit/Pterodactyl panel. */
  scheduleRestart() {
    const available = this.availability();
    if (!available.ok) return available;
    return {
      ok: false,
      reason: 'Kerit does not expose a safe in-container restart. Press Restart in the server panel; do not stop the server unless you intend to leave the bot offline.',
    };
  }
}

export default KeritControl;
