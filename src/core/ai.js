/**
 * Nexus-WA — AI orchestrator.
 *
 * One interface over three providers, tried in priority order (AI_PROVIDERS), all called with plain fetch so there is
 * no vendor SDK to keep updated:
 *
 *   groq    OpenAI-compatible /chat/completions   (fast, free tier)
 *   openai  OpenAI-compatible /chat/completions
 *   openrouter OpenAI-compatible; model openrouter/free picks a free model
 *   gemini  Google generateContent
 *
 * If no API key is configured the provider throws `AiNotConfigured`, and the
 * plugin turns that into a plain "not configured yet" reply. That path is
 * deliberately NOT silent: a bot that quietly pretends to be an AI is worse
 * than one that admits it has no key.
 *
 * Conversation memory is per-chat, in memory, capped. It does not survive a
 * restart — that is a conscious choice, since the alternative is storing every
 * message you ever sent to a model in SQLite with no retention policy.
 */

const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
};

// Vision support belongs to the selected *model*, not to a whole provider.
// In particular Groq's default text model (openai/gpt-oss-120b) cannot accept
// image_url content. Keep this conservative: skipping an unknown model lets a
// known vision-capable fallback answer instead of needlessly sending a failing
// request (and a user image) to a text-only model.
const IMAGE_MODEL_PATTERNS = {
  gemini: [/^gemini-/i],
  // Qwen 3.8 27B is Groq's documented vision model. GPT-OSS remains the
  // default text model, so image requests swap to Qwen below.
  groq: [/^qwen\/qwen3\.8-27b$/i, /^meta-llama\/llama-4-(?:scout|maverick)-/i],
  openai: [/^gpt-4o(?:-|$)/i, /^gpt-4\.1(?:-|$)/i, /^gpt-5(?:-|$)/i],
  openrouter: [
    // OpenRouter's free router filters its current free roster by required
    // capabilities, including image understanding.
    /^openrouter\/free$/i,
    /^google\/gemini-/i,
    /^google\/gemma-/i,
    /^qwen\/qwen3(?:\.|-|$)/i,
    /^openai\/gpt-4o(?:-|$)/i,
    /^openai\/gpt-4\.1(?:-|$)/i,
    /^meta-llama\/llama-4-(?:scout|maverick)-/i,
    /^nvidia\/nemotron-.*(?:omni|vision)/i,
  ],
};

/** Whether one exact provider/model pair is known to accept image input. */
export function modelSupportsImages(provider, model) {
  return (IMAGE_MODEL_PATTERNS[provider] || []).some((pattern) => pattern.test(String(model || '')));
}

// Checked against each provider's docs. Groq retired llama-3.3-70b-versatile on
// free and developer tiers (Aug 2026); Google shut down gemini-2.0-flash (Jun 2026).
// If one of these is retired, `.ai check` says so; change it here or set AI_MODEL.
const DEFAULT_MODEL = {
  groq: 'openai/gpt-oss-120b',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-3.8-flash',
  // Fixed on purpose: the free router picks a free model per request.
  openrouter: 'openrouter/free',
};

// Do not make every ordinary text request use a vision model. For an image
// request only, replace an explicitly text-only configured/default model with
// a no-extra-config documented image model from the same provider.
const DEFAULT_IMAGE_MODEL = {
  groq: 'qwen/qwen3.8-27b',
  openrouter: 'openrouter/free',
};

/**
 * Turn a raw provider failure into a plain reason. Pure, so it can be tested.
 * @param {string} message  the provider's own error text
 * @param {number|null} status  HTTP status, when there was one
 */
export function explainProviderError(message = '', status = null) {
  const m = String(message);
  if (status === 401 || /api key not valid|invalid api key|invalid_api_key|api_key_invalid|unauthori[sz]ed/i.test(m)) {
    return 'the key was rejected. It is wrong, was revoked, or was pasted incompletely. Make a new key in the provider console and set it again.';
  }
  if (status === 403 || /permission denied|forbidden|access denied/i.test(m)) {
    return 'the key works, but this account is not allowed to use this model or region. Check the provider console.';
  }
  if (status === 404 || (/model/i.test(m) && /not found|does not exist|no longer available|decommissioned|shut ?down|retired/i.test(m))) {
    return 'the model name is retired or not available to this account, so the bot needs a newer model name.';
  }
  if (status === 429 || /quota|rate limit|resource_exhausted|too many requests/i.test(m)) {
    return 'the free quota or rate limit is used up. Wait a while, or check the usage page of the provider.';
  }
  if ((status && status >= 500) || /overloaded|temporarily unavailable|internal error/i.test(m)) {
    return 'the provider is having trouble on their side. Try again in a few minutes.';
  }
  if (/returned no content|used its whole reply limit/i.test(m)) {
    return 'the model answered with no text. Reasoning models can use the whole reply limit before writing anything, and the free router sometimes picks a model that returns nothing. Try again; the fallback will use the next provider.';
  }
  if (/timed out|timeout|aborted/i.test(m)) {
    return 'the provider did not answer in time. Check the phone\'s internet connection, then try again.';
  }
  if (/fetch failed|enotfound|econnrefused|eai_again|network/i.test(m)) {
    return 'the phone could not reach the provider. Check the internet connection and DNS.';
  }
  return `unexpected provider error: ${m.slice(0, 120)}`;
}

export class AiNotConfigured extends Error {
  constructor(provider) {
    super(
      `AI provider "${provider}" has no API key set. Add ${String(provider).toUpperCase()}_API_KEY to .env.`
    );
    this.name = 'AiNotConfigured';
  }
}

export class AiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

export class AiClient {
  /**
   * @param {object} deps
   * @param {object} deps.config     app config (config.ai)
   * @param {object} deps.logger
   * @param {Function} [deps.fetchImpl] injectable for tests
   */
  constructor({ config, logger, fetchImpl = null }) {
    this.config = config.ai;
    this.logger = logger.child({ scope: 'ai' });
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    /** @type {Map<string, Array<{role:string, content:string}>>} */
    this.memory = new Map();
    this.stats = { calls: 0, errors: 0, charsIn: 0, charsOut: 0 };
  }

  /**
   * Providers that have a key, best priority first. Each link carries its own
   * key and model; AI_MODEL only applies to the provider it was named for.
   */
  chain({ images = false } = {}) {
    const ordered = (this.config.providers || []).filter((e) => this.config.keys?.[e.provider]);
    return ordered
      .map((e) => {
        const selected =
          (e.provider === this.config.provider && this.config.model) || DEFAULT_MODEL[e.provider];
        // An AI_MODEL choice is often a text model. Image commands should not
        // fail merely because the same provider has a documented vision model
        // available without another key or setting.
        const model = images && !modelSupportsImages(e.provider, selected)
          ? DEFAULT_IMAGE_MODEL[e.provider] || selected
          : selected;
        return { provider: e.provider, key: this.config.keys[e.provider], model };
      })
      .filter((link) => !images || modelSupportsImages(link.provider, link.model));
  }

  /**
   * Make one small call to one provider, with no fallback, so the result is
   * about that provider alone. Never throws: the result says what went wrong.
   * @returns {Promise<{provider:string, model:string, ok:boolean, reply?:string, problem?:string, raw?:string, ms:number}>}
   */
  async check(provider, { timeoutMs = 60_000 } = {}) {
    const key = this.config.keys?.[provider];
    const model = (provider === this.config.provider && this.config.model) || DEFAULT_MODEL[provider] || '';
    const started = Date.now();
    if (!key) {
      return {
        provider, model, ok: false, ms: 0,
        problem: `no API key in .env. Add ${provider.toUpperCase()}_API_KEY to .env and restart.`,
      };
    }
    if (provider !== 'gemini' && !ENDPOINTS[provider]) {
      return { provider, model, ok: false, ms: 0, problem: 'this provider cannot be checked.' };
    }
    const link = { provider, key, model };
    const args = {
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      // Reasoning models spend tokens on hidden thinking first, so a tiny
      // budget comes back empty. This is enough for them to finish.
      maxTokens: 400,
      temperature: 0,
      images: [],
    };
    try {
      const call = provider === 'gemini' ? this.#gemini(link, args) : this.#openAiCompatible(link, args);
      const text = await Promise.race([
        call,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), timeoutMs).unref?.()),
      ]);
      return { provider, model, ok: true, reply: String(text).trim().slice(0, 60), ms: Date.now() - started };
    } catch (err) {
      // The key must never reach the chat, even if a provider echoes it back.
      const raw = String(err.message || err).split(key).join('[key]').slice(0, 200);
      return {
        provider, model, ok: false, ms: Date.now() - started,
        problem: explainProviderError(raw, err.status ?? null),
        raw,
      };
    }
  }

  /** Name of the highest-priority configured provider. */
  get provider() {
    return this.chain()[0]?.provider || this.config.provider || 'groq';
  }

  configured() {
    return this.chain().length > 0;
  }

  /** Model of the highest-priority configured provider (for display). */
  get model() {
    return this.chain()[0]?.model || this.config.model || '';
  }

  /** Trim memory for one chat to the configured window. */
  #remember(chatKey, entry) {
    const list = this.memory.get(chatKey) || [];
    list.push(entry);
    const cap = Math.max(2, this.config.maxHistory || 12);
    while (list.length > cap) list.shift();
    this.memory.set(chatKey, list);
    return list;
  }

  history(chatKey) {
    return this.memory.get(chatKey) || [];
  }

  forget(chatKey) {
    return this.memory.delete(chatKey);
  }

  /**
   * @param {object} req
   * @param {string} req.prompt
   * @param {string} [req.system]
   * @param {string} [req.chatKey]  enables per-chat memory
   * @param {number} [req.maxTokens]
   * @param {number} [req.temperature]
   * @param {Array}  [req.images]   base64 data, gemini/vision only
   * @returns {Promise<string>}
   */
  async complete({ prompt, system = null, chatKey = null, maxTokens = 800, temperature = 0.4, images = [] }) {
    const links = this.chain({ images: images.length > 0 });
    if (!links.length && images.length && this.configured()) {
      throw new AiError(
        'no configured AI model can read images. Add a Groq, Gemini, or OpenRouter key; Groq image requests use qwen/qwen3.8-27b automatically.'
      );
    }
    if (!links.length) throw new AiNotConfigured(this.provider);
    if (!prompt?.trim()) throw new AiError('empty prompt');

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    if (chatKey) messages.push(...this.history(chatKey));
    messages.push({ role: 'user', content: prompt });

    let text = null;
    const failures = [];
    for (const link of links) {
      try {
        text =
          link.provider === 'gemini'
            ? await this.#gemini(link, { messages, maxTokens, temperature, images })
            : await this.#openAiCompatible(link, { messages, maxTokens, temperature, images });
        if (failures.length) this.logger.warn({ failures }, 'ai answered after fallback');
        break;
      } catch (err) {
        this.stats.errors++;
        failures.push(`${link.provider}: ${err.message}`);
        this.logger.warn({ provider: link.provider, err: err.message }, 'ai provider failed, trying next');
      }
    }
    if (text === null) {
      throw new AiError(`all providers failed (${failures.join('; ')})`);
    }

    if (chatKey) {
      this.#remember(chatKey, { role: 'user', content: prompt });
      this.#remember(chatKey, { role: 'assistant', content: text });
    }

    this.stats.calls++;
    this.stats.charsIn += prompt.length;
    this.stats.charsOut += text.length;
    return text;
  }

  async #openAiCompatible(link, { messages, maxTokens, temperature, images }) {
    const url = ENDPOINTS[link.provider];
    if (!url) throw new AiError(`unsupported provider "${link.provider}"`);

    // Vision is only wired for the multimodal message shape.
    const payloadMessages = images.length
      ? messages.map((m) =>
          m.role === 'user'
            ? {
                role: 'user',
                content: [
                  { type: 'text', text: m.content },
                  ...images.map((b64) => ({
                    type: 'image_url',
                    image_url: { url: b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}` },
                  })),
                ],
              }
            : m
        )
      : messages;

    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${link.key}` },
      body: JSON.stringify({
        model: link.model,
        messages: payloadMessages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    return this.#handle(res, (json) => {
      const out = json?.choices?.[0]?.message?.content;
      if (!out) {
        if (json?.choices?.[0]?.finish_reason === 'length') {
          throw new AiError(
            'the model used its whole reply limit on hidden reasoning and wrote no answer. Try again, or pick a model that does not reason by default.'
          );
        }
        throw new AiError(`provider returned no content: ${JSON.stringify(json).slice(0, 300)}`);
      }
      return out;
    });
  }

  async #gemini(link, { messages, maxTokens, temperature, images }) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${link.model}:generateContent?key=${link.key}`;

    const system = messages.find((m) => m.role === 'system')?.content || null;
    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        const parts = [{ text: m.content }];
        if (m.role === 'user') {
          for (const b64 of images) {
            parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64.replace(/^data:[^,]+,/, '') } });
          }
        }
        return { role: m.role === 'assistant' ? 'model' : 'user', parts };
      });

    const res = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: maxTokens, temperature },
      }),
      signal: AbortSignal.timeout(60_000),
    });

    return this.#handle(res, (json) => {
      const out = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('');
      if (!out) throw new AiError(`provider returned no content: ${JSON.stringify(json).slice(0, 300)}`);
      return out;
    });
  }

  /**
   * Speech-to-text. Both OpenAI and Groq expose the same
   * `/audio/transcriptions` multipart shape, so one implementation covers both.
   * Gemini has no equivalent here — calling it there reports that honestly
   * instead of silently returning nothing.
   *
   * @param {object} req
   * @param {string} req.base64
   * @param {string} [req.mime]
   * @returns {Promise<string>}
   */
  async transcribeAudio({ base64, mime = 'audio/ogg' }) {
    // Transcription is only wired for OpenAI-compatible endpoints (groq, openai).
    const link = this.chain().find((l) => l.provider === 'groq' || l.provider === 'openai');
    if (!link) throw new AiNotConfigured(this.provider);

    const base = ENDPOINTS[link.provider];
    const url = base.replace(/\/chat\/completions$/, '/audio/transcriptions');
    const ext = /ogg|opus/i.test(mime) ? 'ogg' : /mpeg|mp3/i.test(mime) ? 'mp3' : 'wav';
    const bytes = Buffer.from(base64, 'base64');

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), `voice.${ext}`);
    form.append('model', link.provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1');
    form.append('response_format', 'json');

    const res = await this.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${link.key}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });

    this.stats.calls++;
    return this.#handle(res, (json) => {
      const out = json?.text;
      if (!out) throw new AiError(`provider returned no transcript: ${JSON.stringify(json).slice(0, 300)}`);
      this.stats.charsOut += out.length;
      return out;
    });
  }


  async #handle(res, extract) {    const body = await res.text();
    if (!res.ok) {
      this.stats.errors++;
      let detail = body.slice(0, 300);
      try {
        detail = JSON.parse(body)?.error?.message || detail;
      } catch {
        /* keep raw */
      }
      throw new AiError(`provider ${res.status}: ${detail}`, res.status);
    }
    let json;
    try {
      json = JSON.parse(body);
    } catch (err) {
      throw new AiError(`provider returned non-JSON: ${err.message}`);
    }
    return extract(json);
  }
}

export default AiClient;
