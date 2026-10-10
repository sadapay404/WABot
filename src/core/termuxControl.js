import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
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

function readPid(filePath) {
  try {
    const value = Number(fs.readFileSync(filePath, 'utf8').trim());
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shortHash(value) {
  return String(value || '').trim().slice(0, 7);
}

/** Safe update/restart controls for the documented Termux supervisor install. */
export class TermuxControl {
  constructor({
    root,
    logger,
    env = process.env,
    home = os.homedir(),
    pid = process.pid,
    run = runCommand,
    spawnImpl = spawn,
    hasProcess = processExists,
    schedule = setTimeout,
  }) {
    this.root = path.resolve(root);
    this.logger = logger.child({ scope: 'termux-control' });
    this.env = env;
    this.home = path.resolve(home);
    this.pid = pid;
    this.run = run;
    this.spawn = spawnImpl;
    this.hasProcess = hasProcess;
    this.schedule = schedule;
  }

  availability() {
    const prefix = String(this.env.PREFIX || '');
    if (!/\/com\.termux\/files\/usr\/?$/.test(prefix)) {
      return { ok: false, reason: 'These controls are available only in the Termux install.' };
    }

    const appDir = path.join(this.home, 'nexus-wa');
    if (this.root !== path.resolve(appDir)) {
      return { ok: false, reason: 'The running bot is not from the standard ~/nexus-wa install.' };
    }
    if (!fs.existsSync(path.join(appDir, 'package.json')) ||
        !fs.existsSync(path.join(appDir, '.git')) ||
        !fs.existsSync(path.join(appDir, 'deploy', 'termux', 'nexus'))) {
      return { ok: false, reason: 'The Termux repository or supervisor script is missing.' };
    }

    const nexusPath = path.join(prefix, 'bin', 'nexus');
    if (!fs.existsSync(nexusPath)) {
      return { ok: false, reason: 'The nexus supervisor command is not installed in Termux.' };
    }

    const dataDir = path.join(this.home, '.nexus-wa');
    const supervisorPid = readPid(path.join(dataDir, 'nexus.pid'));
    const botPid = readPid(path.join(dataDir, 'nexus.bot.pid'));
    if (!supervisorPid || !this.hasProcess(supervisorPid) || botPid !== this.pid) {
      return {
        ok: false,
        reason: 'Start the bot with `nexus start` before using WhatsApp update/restart controls.',
      };
    }

    return { ok: true, appDir, dataDir, nexusPath, supervisorPid, botPid };
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
          reason: 'The repo has local changes. They were left untouched; update from Termux after reviewing them.',
        };
      }

      const branch = (await this.run('git', ['branch', '--show-current'], options)).stdout.trim();
      const upstream = (await this.run(
        'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], options
      )).stdout.trim();
      if (!branch || !upstream) {
        return { ok: false, reason: 'This branch has no GitHub upstream configured.' };
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
        nexusPath: available.nexusPath,
        branch,
        upstream,
        current: shortHash(current),
        remote: shortHash(remote),
        ahead: counts[0],
        behind: counts[1],
      };
    } catch (error) {
      this.logger.warn(`Termux update check failed: ${error.message}`);
      return { ok: false, reason: 'Could not check GitHub. Check the phone connection and try again.' };
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
    if (status.behind === 0) return { ...status, updated: false };

    try {
      await this.run('git', ['pull', '--ff-only'], {
        cwd: status.appDir,
        env: this.env,
        timeout: GIT_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.warn(`Termux fast-forward pull failed: ${error.message}`);
      return { ok: false, reason: 'Git could not fast-forward this branch; no reset or forced update was attempted.' };
    }

    try {
      await this.run('npm', ['install', '--omit=optional', '--no-audit', '--fund=false'], {
        cwd: status.appDir,
        env: this.env,
        timeout: INSTALL_TIMEOUT_MS,
      });
    } catch (error) {
      this.logger.error(`Termux dependency install failed: ${error.message}`);
      return { ok: false, reason: 'Code updated, but dependency installation failed. The bot was not restarted.' };
    }

    try {
      const current = (await this.run('git', ['rev-parse', '--short', 'HEAD'], {
        cwd: status.appDir,
        env: this.env,
        timeout: GIT_TIMEOUT_MS,
      })).stdout.trim();
      return { ...status, current: shortHash(current), updated: true };
    } catch {
      return { ...status, updated: true };
    }
  }

  scheduleRestart(delayMs = 2_000) {
    const available = this.availability();
    if (!available.ok) return available;

    const timer = this.schedule(() => {
      try {
        const child = this.spawn(available.nexusPath, ['restart'], {
          cwd: available.appDir,
          env: this.env,
          detached: true,
          stdio: 'ignore',
        });
        child.once?.('error', (error) => this.logger.error(`could not launch nexus restart: ${error.message}`));
        child.unref?.();
      } catch (error) {
        this.logger.error(`could not launch nexus restart: ${error.message}`);
      }
    }, delayMs);
    timer?.unref?.();
    return { ok: true };
  }
}

export default TermuxControl;
