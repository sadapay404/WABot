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
import { normalizeJid } from './jid.js';

const SELF_ECHO_TTL_MS = 120_000;
const SELF_ECHO_MAX_KEYS = 500;


function sameJid(a, b) {
  return Boolean(a && b) && normalizeJid(a) === normalizeJid(b);
}

/**
 * First requirement whose argument is absent or fails validation. Plugins
 * declare `requires: [{ index, name, prompt, validate }]`; validate returns the
 * normalised value, or null when the answer is unusable.
 */
function firstMissingArg(plugin, args = []) {
  if (!args.length || !Array.isArray(plugin.requires)) return null;
  for (const req of plugin.requires) {
    const current = args[req.index];
    if (current === undefined || req.validate(String(current)) === null) return req;
  }
  return null;
}

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
    this.selfEchoes = new Map();
    this.observedQueues = new WeakSet();
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

  /** Attach echo suppression to the shared outbound queue before it can send. */
  trackSocket(socket) {
    const queue = socket?.__outboundQueue;
    if (!queue?.onBeforeSend || this.observedQueues.has(queue)) return false;
    this.observedQueues.add(queue);
    queue.onBeforeSend((jid, content) => this.#rememberSelfEcho(socket, jid, content));
    return true;
  }

  #echoKey(jid, text) {
    return `${normalizeJid(jid)}\u0000${String(text || '').normalize('NFKC').replace(/\r\n/g, '\n').trim()}`;
  }

  /**
   * Is this chat the account's own "You" chat? WhatsApp addresses it by phone
   * number or by LID depending on the device, so both must match.
   */
  #isSelfChatJid(socket, jid) {
    const target = normalizeJid(jid);
    if (!target) return false;
    return [socket?.user?.id, socket?.user?.lid].some((id) => normalizeJid(id) === target);
  }

  #rememberSelfEcho(socket, jid, content) {
    if (!this.#isSelfChatJid(socket, jid)) return;
    const text = typeof content === 'string' ? content : content?.text ?? content?.caption ?? '';
    if (!String(text).trim()) return;
    const now = Date.now();
    for (const [key, expiries] of this.selfEchoes) {
      const live = expiries.filter((expires) => expires > now);
      if (live.length) this.selfEchoes.set(key, live);
      else this.selfEchoes.delete(key);
    }
    const key = this.#echoKey(jid, text);
    const expiries = this.selfEchoes.get(key) || [];
    expiries.push(now + SELF_ECHO_TTL_MS);
    this.selfEchoes.set(key, expiries);
    while (this.selfEchoes.size > SELF_ECHO_MAX_KEYS) {
      this.selfEchoes.delete(this.selfEchoes.keys().next().value);
    }
  }

  #consumeSelfEcho(socket, msg) {
    if (!this.#isSelfChatJid(socket, msg.jid) || !msg.text) return false;
    const key = this.#echoKey(msg.jid, msg.text);
    const expiries = (this.selfEchoes.get(key) || []).filter((expires) => expires > Date.now());
    if (!expiries.length) {
      this.selfEchoes.delete(key);
      return false;
    }
    expiries.shift();
    if (expiries.length) this.selfEchoes.set(key, expiries);
    else this.selfEchoes.delete(key);
    return true;
  }

  /**
   * Handle one normalised message. In the account's own “You” chat, explicitly
   * owner-only commands are allowed only from configured owners; plain-text
   * replies are accepted only while a persisted scheduling draft is active.
   */
  async handle(socket, msg) {
    try {
      this.trackSocket(socket);
      if (!msg.text) return; // media-only handling arrives in Phase 3
      // Status broadcasts are captured by statusFeed, never answered or read.
      if (normalizeJid(msg.jid) === 'status@broadcast') return;

      const isSelfChat = this.#isSelfChatJid(socket, msg.jid);
      const isFromSelfChat = Boolean(msg.isBot && isSelfChat);

      // Our own queued messages (including prompts) can arrive as fromMe
      // upserts in the “You” chat. Drop the exact outbound echo before looking
      // for a command or a pending free-text answer.
      if (isFromSelfChat && this.#consumeSelfEcho(socket, msg)) return;
      if (msg.isBot && !isSelfChat) return; // ignore every outgoing message to other chats
      // Baileys marks history replays and emitted local-send echoes as append.
      // Never execute these as phone-entered self-chat commands.
      if (isFromSelfChat && msg.upsertType && msg.upsertType !== 'notify') return;

      const parsed = parseCommand(msg, this.config.prefix);
      const isOwner = this.isOwner(msg.sender);
      const candidate = parsed.isCommand ? this.plugins.resolve(parsed.command) : null;
      // Any explicitly owner-only command may be used in the owner's own
      // “You” chat. Echo tracking and the notify-vs-append guard above still
      // prevent our replies/history from replaying as commands.
      const selfChatCommand =
        parsed.isCommand &&
        isOwner &&
        Boolean(candidate?.ownerOnly);
      const wizard = this.bot?.scheduleWizard;
      const pendingDraft = isOwner && wizard?.hasPending?.(msg.sender, msg.jid);
      // A question the bot is waiting on (missing argument, status number).
      const prompt = this.bot?.prompts?.peek?.(msg.jid) || null;
      const promptIsMine = Boolean(prompt) &&
        (prompt.ownerOnly ? isOwner : sameJid(prompt.sender, msg.sender));

      if (isFromSelfChat && parsed.isCommand && !selfChatCommand) return;
      if (isFromSelfChat && !selfChatCommand && !pendingDraft && !promptIsMine) return;

      if (promptIsMine && !candidate) {
        if (this.config.isObserve && !(isOwner && this.config.safety.observeAllowReplyToOwner)) {
          this.stats.rejected++;
          return;
        }
        const entry = this.bot.prompts.take(msg.jid);
        if (entry) {
          this.stats.handled++;
          await entry.onReply({
            text: msg.text.trim(),
            socket,
            reply: (text, options) => this.#reply(socket, msg, text, options),
          });
          return;
        }
      }

      if (!parsed.isCommand) {
        if (!pendingDraft || !wizard?.handleReply) return;
        if (this.config.isObserve && !(isOwner && this.config.safety.observeAllowReplyToOwner)) {
          this.stats.rejected++;
          return;
        }
        this.stats.handled++;
        await wizard.handleReply({
          socket,
          msg,
          reply: (text, options) => this.#reply(socket, msg, text, options),
        });
        return;
      }

      const plugin = candidate;
      if (!plugin) {
        this.stats.rejected++;
        this.logger.debug(`unknown command: ${parsed.command}`);
        return;
      }

      // ── Gate 1: authorisation ──────────────────────────────────
      if (plugin.ownerOnly && !isOwner) {
        this.stats.rejected++;
        // Deliberately SILENT. Answering a stranger with "that's owner-only"
        // confirms a bot exists on this number and invites probing — exactly
        // the traffic pattern that gets a personal account flagged.
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

      // ── Gate 3: observe-mode outbound block ─────────────────────
      if (this.config.isObserve && !(isOwner && this.config.safety.observeAllowReplyToOwner)) {
        this.stats.rejected++;
        this.logger.info(
          `observe mode: swallowed .${plugin.name} from ${msg.sender} (outbound blocked)`
        );
        return;
      }

      // ── Missing or invalid arguments: ask for them, then carry on ──
      const missing = firstMissingArg(plugin, parsed.args);
      if (missing && this.bot?.prompts) {
        return this.#askForArg(socket, msg, parsed, isOwner, plugin, missing);
      }

      await this.#execute(socket, msg, parsed, isOwner, plugin);
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

  async #execute(socket, msg, parsed, isOwner, plugin) {
    this.stats.handled++;
    const ctx = this.#buildContext(socket, msg, parsed, isOwner, plugin);
    this.logger.debug(`exec .${plugin.name} (owner=${isOwner})`);
    await plugin.execute(ctx);
  }

  /** Ask for one missing argument. The answer comes back through #collectArg. */
  #askForArg(socket, msg, parsed, isOwner, plugin, missing, note = '') {
    this.bot.prompts.set(msg.jid, {
      kind: 'arg',
      ownerOnly: Boolean(plugin.ownerOnly),
      sender: msg.sender,
      onReply: ({ text, reply }) =>
        this.#collectArg(socket, msg, parsed, isOwner, plugin, missing, text, reply),
    });
    const body = note ? `${note}\n${missing.prompt}` : missing.prompt;
    return this.#reply(socket, msg, body);
  }

  async #collectArg(socket, msg, parsed, isOwner, plugin, missing, text, reply) {
    const value = missing.validate(String(text || '').trim());
    if (value === null || value === undefined) {
      return this.#askForArg(socket, msg, parsed, isOwner, plugin, missing, 'That is not valid.');
    }
    const args = [...parsed.args];
    args[missing.index] = value;
    // Normalise every argument that is already valid, so the plugin gets the
    // same types whether the user typed it up front or was asked for it.
    for (const req of plugin.requires || []) {
      if (args[req.index] === undefined) continue;
      const normalised = req.validate(String(args[req.index]));
      if (normalised !== null) args[req.index] = normalised;
    }

    const next = firstMissingArg(plugin, args);
    if (next) return this.#askForArg(socket, msg, { ...parsed, args }, isOwner, plugin, next);

    const filled = { ...parsed, args, argsRaw: args.join(' ') };
    return this.#execute(socket, msg, filled, isOwner, plugin);
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
    this.trackSocket(socket);
    // Baileys' hard ceiling per message; split rather than truncate silently.
    const LIMIT = 4000;
    const chunks = [];
    for (let i = 0; i < String(text).length; i += LIMIT) {
      chunks.push(String(text).slice(i, i + LIMIT));
    }
    let last;
    for (const chunk of chunks) {
      if (!socket?.__outboundQueue?.onBeforeSend) {
        this.#rememberSelfEcho(socket, msg.jid, { text: chunk });
      }
      last = await socket.sendMessage(msg.jid, { text: chunk }, options);
    }
    return last;
  }
}

export default Dispatcher;
