/**
 * Nexus-WA — dynamic plugin loader.
 *
 * Adding a feature = dropping one file into src/plugins/. No registry edits,
 * no imports to add, no restart wiring. On cloud platforms with a read-only
 * FS this still works because the plugin directory ships inside the image.
 *
 * A plugin module exports a default object:
 * {
 *   name: 'ping',                 // unique, becomes the command name
 *   aliases: ['p'],
 *   category: 'tools',
 *   description: 'Latency check',
 *   usage: '.ping',
 *   ownerOnly: false,             // gate to OWNER_JIDS
 *   groupOnly: false,
 *   privateOnly: false,
 *   enabled: true,
 *   cooldownMs: 0,
 *   async execute(ctx) {}         // ctx is documented in dispatcher.js
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class PluginLoader {
  constructor({ dir, logger }) {
    this.dir = dir;
    this.logger = logger.child({ scope: 'plugins' });
    /** @type {Map<string, object>} command name -> plugin */
    this.commands = new Map();
    /** @type {Map<string, string>} alias -> command name */
    this.aliases = new Map();
    /** @type {Array<{file:string, error:string}>} */
    this.failures = [];
  }

  /**
   * Scan the plugin directory and import every .js file.
   * A broken plugin is quarantined — it can never take the bot down with it.
   */
  async loadAll() {
    this.commands.clear();
    this.aliases.clear();
    this.failures = [];

    if (!fs.existsSync(this.dir)) {
      this.logger.warn(`plugin directory not found: ${this.dir}`);
      return this;
    }

    const files = fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.js') && !f.startsWith('_') && !f.endsWith('.test.js'))
      .sort();

    for (const file of files) {
      await this.#loadOne(path.join(this.dir, file));
    }

    this.logger.info(
      `loaded ${this.commands.size} command(s) from ${files.length} file(s)` +
        (this.failures.length ? `, ${this.failures.length} failed` : '')
    );
    return this;
  }

  async #loadOne(filePath) {
    const rel = path.basename(filePath);
    try {
      const mod = await import(`${pathToFileURL(filePath).href}?t=${Date.now()}`);
      const plugin = mod.default ?? mod;

      // Two supported shapes:
      //   export default { name, execute }              → one command
      //   export default { commands: [ {name, execute} ] } → several related ones
      const list = Array.isArray(plugin?.commands) ? plugin.commands : [plugin];

      if (!list.length || list.some((p) => typeof p?.execute !== 'function')) {
        throw new Error('plugin must export default { execute(ctx) } or { commands: [...] }');
      }

      let added = 0;
      for (const item of list) {
        const name = String(item.name || rel.replace(/\.js$/, '')).toLowerCase();
        if (this.commands.has(name)) {
          throw new Error(`command name "${name}" already registered`);
        }
        if (item.enabled === false) continue;

        // Group-level defaults, overridable per command.
        const record = {
          category: plugin.category,
          ownerOnly: plugin.ownerOnly,
          ...item,
          name,
          file: rel,
        };
        this.commands.set(name, record);
        for (const alias of item.aliases || []) {
          const a = String(alias).toLowerCase();
          if (!this.commands.has(a) && !this.aliases.has(a)) this.aliases.set(a, name);
        }
        added++;
      }

      if (!added) {
        this.logger.debug(`skipped ${rel} (all commands disabled)`);
        return;
      }
      this.logger.debug(`+ ${added} command(s) from ${rel}`);
    } catch (err) {
      this.failures.push({ file: rel, error: err.message });
      this.logger.error(`failed to load ${rel}: ${err.message}`);
    }
  }

  /** Resolve a command name or alias to its plugin record. */
  resolve(input) {
    const key = String(input || '').toLowerCase();
    return this.commands.get(key) || this.commands.get(this.aliases.get(key));
  }

  /** Flat list, for .help and the Telegram panel. */
  list() {
    return [...this.commands.values()]
      .map((p) => ({
        name: p.name,
        aliases: p.aliases || [],
        category: p.category || 'misc',
        description: p.description || '',
        usage: p.usage || `.${p.name}`,
        ownerOnly: Boolean(p.ownerOnly),
      }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  }

  listByCategory() {
    const out = new Map();
    for (const p of this.list()) {
      if (!out.has(p.category)) out.set(p.category, []);
      out.get(p.category).push(p);
    }
    return out;
  }
}

export default PluginLoader;
