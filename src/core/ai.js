/**
 * Nexus-WA — AI orchestrator.
 *
 * One interface over three providers, all called with plain fetch so there is
 * no vendor SDK to keep updated:
 *
 *   groq    OpenAI-compatible /chat/completions   (fast, free tier)
 *   openai  OpenAI-compatible /chat/completions
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
};

const DEFAULT_MODEL = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
};

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

  get provider() {
    return this.config.provider || 'groq';
  }

  get key() {
    return this.config.keys?.[this.provider] || '';
  }

  get model() {
    return this.config.model || DEFAULT_MODEL[this.provider] || DEFAULT_MODEL.groq;
  }

  configured() {
    return Boolean(this.key);
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
    if (!this.configured()) throw new AiNotConfigured(this.provider);
    if (!prompt?.trim()) throw new AiError('empty prompt');

    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    if (chatKey) messages.push(...this.history(chatKey));
    messages.push({ role: 'user', content: prompt });

    const text =
      this.provider === 'gemini'
        ? await this.#gemini({ messages, maxTokens, temperature, images })
        : await this.#openAiCompatible({ messages, maxTokens, temperature, images });

    if (chatKey) {
      this.#remember(chatKey, { role: 'user', content: prompt });
      this.#remember(chatKey, { role: 'assistant', content: text });
    }

    this.stats.calls++;
    this.stats.charsIn += prompt.length;
    this.stats.charsOut += text.length;
    return text;
  }

  async #openAiCompatible({ messages, maxTokens, temperature, images }) {
    const url = ENDPOINTS[this.provider];
    if (!url) throw new AiError(`unsupported provider "${this.provider}"`);

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
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: this.model,
        messages: payloadMessages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    return this.#handle(res, (json) => {
      const out = json?.choices?.[0]?.message?.content;
      if (!out) throw new AiError(`provider returned no content: ${JSON.stringify(json).slice(0, 300)}`);
      return out;
    });
  }

  async #gemini({ messages, maxTokens, temperature, images }) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.key}`;

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
    if (!this.configured()) throw new AiNotConfigured(this.provider);

    const base = ENDPOINTS[this.provider];
    if (!base) {
      throw new AiError(
        `provider "${this.provider}" has no audio transcription endpoint in this client`
      );
    }

    const url = base.replace(/\/chat\/completions$/, '/audio/transcriptions');
    const ext = /ogg|opus/i.test(mime) ? 'ogg' : /mpeg|mp3/i.test(mime) ? 'mp3' : 'wav';
    const bytes = Buffer.from(base64, 'base64');

    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), `voice.${ext}`);
    form.append('model', this.provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1');
    form.append('response_format', 'json');

    const res = await this.fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.key}` },
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
