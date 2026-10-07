/**
 * Nexus-WA — command dispatcher.
 *
 * Sits between "a message arrived" and "a plugin ran". Everything that makes
 * this bot safe to run on a personal number lives here, in one auditable place:
 *
 *   1. ownership / authorisation gates
 *   2. observe-mode outbound blocking
 *   3. per-command cooldowns
 *   4. error containment (a throwing plugin never crashes the process)
 *
 * The `ctx` object passed to plugin.execute() is the plugin contract:
 *
 *   ctx.socket   the WhatsApp socket (real Baileys OR MockWhatsAppSocket)
 *   ctx.msg      normalised message (see core/message.js)
 *   ctx.args     ['hello','world']   — whitespace-split arguments
 *   ctx.text     'hello world'       — raw argument string
 *   ctx.reply(t) send text back to the originating chat
 *   ctx.isOwner  boolean
 *   ctx.isGroup  boolean
 *   ctx.logger   scoped logger
 *   ctx.config   app config
 *   ctx.db       database handle
 *   ctx.plugins  the PluginLoader (so .help can introspect)
 *   ctx.bot      app-level services (scheduler, telegram, …)
 */

import { parseCommand } from './message.js';

export class Dispatcher {
  /**
   * @param {object} deps
   * @param {import('./pluginLoader.js').PluginLoader} deps.plugins
   * @param {object} deps.config
   * @param {object} deps.logger
   * @param {object} [deps.db]
   * @param {object} [deps.bot]
   */
  constructor({ plugins, config, logger, db = null, bot = {}, defaultOwnerJid = null }) {
    this.plugins = plugins;
    this.config = config;
    this.logger = logger.child({ scope: 'dispatch' });
    this.db = db;
    this.bot = bot;
    /**
     * Used ONLY when OWNER_JIDS is unset. In dry-run this is the simulated
     * owner, which is what makes `/as <stranger> .cmd` a faithful test of the
     * authorisation gate instead of a rubber stamp.
     */
    this.defaultOwnerJid = defaultOwnerJid;
    /** name -> last invocation ms */
    this.lastRun = new Map();
    this.stats = { handled: 0, rejected: 0, errors: 0 };
  }

  isOwner(jid) {
    const owners = this.config.safety.ownerJids.length
      ? this.config.safety.ownerJids
      : this.defaultOwnerJid
        ? [this.defaultOwnerJid]
        : [];
    // Empty whitelist means "nobody". Failing closed is the only acceptable
    // default for commands that can send messages from your personal number.
    if (owners.length === 0) return false;
    const bare = String(jid).split(':')[0].split('@')[0];
    return owners.some((o) => {
      const ob = String(o).split(':')[0].split('@')[0];
      return o === jid || ob === bare;
    });
  }

  /**
   * Handle one normalised message.
   * @param {object} socket real or mock socket
   * @param {object} msg normalised message from core/message.js
   */
  async handle(socket, msg) {
    try {
      if (msg.isBot) return; // never react to our own messages
      if (!msg.text) return; // media-only handling arrives in Phase 3

      const parsed = parseCommand(msg, this.config.prefix);
      if (!parsed.isCommand) return; // ignore ordinary chat

      const plugin = this.plugins.resolve(parsed.command);
      if (!plugin) {
        this.stats.rejected++;
        this.logger.debug(`unknown command: ${parsed.command}`);
        return;
      }

      const isOwner = this.isOwner(msg.sender);

      // ── Gate 1: authorisation ──────────────────────────────────
      if (plugin.ownerOnly && !isOwner) {
        this.stats.rejected++;
        // Deliberately SILENT. Answering a stranger with "that's owner-only"
        // confirms a bot exists on this number and invites probing — exactly
        // the traffic pattern that gets a personal account flagged. We log it
        // for you and say nothing to them.
        this.logger.warn(`blocked owner-only .${plugin.name} from ${msg.sender}`);
        return;
      }
      if (plugin.groupOnly && !msg.isGroup) return void this.stats.rejected++;
      if (plugin.privateOnly && msg.isGroup) return void this.stats.rejected++;

      // ── Gate 2: per-user cooldown ──────────────────────────────
      const cooldown = Number(plugin.cooldownMs || 0);
      if (cooldown > 0) {
        const key = `${plugin.name}:${msg.sender}`;
        const last = this.lastRun.get(key) || 0;
        const wait = cooldown - (Date.now() - last);
        if (wait > 0) {
          this.stats.rejected++;
          return; // fail silently — throttling should not be spammy
        }
        this.lastRun.set(key, Date.now());
      }

      // ── Gate 3: observe-mode outbound block ────────────────────
      if (this.config.isObserve && !(isOwner && this.config.safety.observeAllowReplyToOwner)) {
        this.stats.rejected++;
        this.logger.info(
          `observe mode: swallowed .${plugin.name} from ${msg.sender} (outbound blocked)`
        );
        return;
      }

      this.stats.handled++;
      const ctx = this.#buildContext(socket, msg, parsed, isOwner, plugin);

      this.logger.debug(`exec .${plugin.name} (owner=${isOwner})`);
      await plugin.execute(ctx);
    } catch (err) {
      this.stats.errors++;
      this.logger.error(`plugin error: ${err.stack || err.message}`);
      try {
        await this.#reply(socket, msg, `⚠️ That command failed: ${err.message}`);
      } catch {
        /* never let the error path itself throw */
      }
    }
  }

  #buildContext(socket, msg, parsed, isOwner, plugin) {
    const self = this;
    return {
      socket,
      wa: socket,
      msg,
      args: parsed.args,
      text: parsed.argsRaw,
      command: parsed.command,
      isOwner,
      isGroup: msg.isGroup,
      sender: msg.sender,
      jid: msg.jid,
      logger: self.logger.child({ scope: plugin.name }),
      config: self.config,
      db: self.db,
      plugins: self.plugins,
      bot: self.bot,
      reply: (text, options) => self.#reply(socket, msg, text, options),
      send: (jid, content, options) => socket.sendMessage(jid, content, options),
    };
  }

  async #reply(socket, msg, text, options = {}) {
    if (!text) return;
    // Baileys' hard ceiling per message; split rather than truncate silently.
    const LIMIT = 4000;
    const chunks = [];
    for (let i = 0; i < String(text).length; i += LIMIT) {
      chunks.push(String(text).slice(i, i + LIMIT));
    }
    let last;
    for (const chunk of chunks) {
      last = await socket.sendMessage(msg.jid, { text: chunk }, options);
    }
    return last;
  }
}

export default Dispatcher;
