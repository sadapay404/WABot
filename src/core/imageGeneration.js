/**
 * Text-to-image client for the one zero-cost provider this deployment supports:
 * Cloudflare Workers AI's daily free allocation. This is deliberately separate
 * from core/ai.js: chat/vision providers return text, while this provider
 * returns image bytes that must be verified before they are sent to WhatsApp.
 */

export const CLOUDFLARE_IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const CLOUDFLARE_API_ROOT = 'https://api.cloudflare.com/client/v4/accounts';
const IMAGE_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 2_048;

export class ImageGenerationNotConfigured extends Error {
  constructor() {
    super('Image generation is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the private controller chat.');
    this.name = 'ImageGenerationNotConfigured';
  }
}

export class ImageGenerationError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'ImageGenerationError';
    this.status = status;
  }
}

function imageFormat(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimetype: 'image/jpeg', ext: 'jpg' };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimetype: 'image/png', ext: 'png' };
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) {
    return { mimetype: 'image/webp', ext: 'webp' };
  }
  return null;
}

function decodeBase64Image(value) {
  const raw = String(value || '').trim().replace(/^data:image\/(?:jpeg|jpg|png|webp);base64,/i, '');
  // Buffer.from() accepts many non-base64 characters, so validate first rather
  // than accidentally treating a provider error message as an image.
  if (!raw || raw.length % 4 === 1 || !/^[a-z0-9+/\s]*={0,2}$/i.test(raw)) return null;
  const bytes = Buffer.from(raw.replace(/\s/g, ''), 'base64');
  const format = imageFormat(bytes);
  return format ? { bytes, ...format } : null;
}

function cloudflareMessage(body, token) {
  let detail = String(body || '').trim();
  try {
    const parsed = JSON.parse(detail);
    detail = parsed?.errors?.[0]?.message || parsed?.error?.message || parsed?.message || detail;
  } catch {
    /* Keep a bounded plain-text response. */
  }
  // A provider should never echo a bearer token, but do not let a bad upstream
  // response turn that guarantee into a chat leak.
  return String(detail).split(String(token || '')).join('[token]').slice(0, 240) || 'no error detail returned';
}

/**
 * @param {object} response Fetch Response-like object
 * @param {string} token
 */
async function imageResult(response, token) {
  const type = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  if (!response.ok) {
    const body = await response.text();
    throw new ImageGenerationError(`Cloudflare returned ${response.status}: ${cloudflareMessage(body, token)}`, response.status);
  }

  // Workers AI normally returns a JSON envelope with result.image. Accept a
  // direct image response as well so the client remains correct if Cloudflare
  // serves image bytes for this endpoint in a future API revision.
  if (type.startsWith('image/')) {
    const bytes = Buffer.from(await response.arrayBuffer());
    const format = imageFormat(bytes);
    if (!format) throw new ImageGenerationError('Cloudflare returned image data in an unsupported or invalid format.');
    return { bytes, ...format };
  }

  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ImageGenerationError('Cloudflare returned a non-JSON image response.');
  }
  if (parsed?.success === false) {
    const detail = parsed?.errors?.[0]?.message || parsed?.messages?.[0]?.message || 'request failed';
    throw new ImageGenerationError(`Cloudflare rejected the request: ${String(detail).split(String(token || '')).join('[token]').slice(0, 240)}`);
  }
  const decoded = decodeBase64Image(parsed?.result?.image ?? parsed?.image);
  if (!decoded) throw new ImageGenerationError('Cloudflare did not return a valid JPEG, PNG, or WebP image.');
  return decoded;
}

export class ImageGenerationClient {
  constructor({ config, logger, fetchImpl = null }) {
    this.config = config.imageGen || {};
    this.logger = logger.child({ scope: 'image-generation' });
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.stats = { calls: 0, errors: 0 };
  }

  configured() {
    return Boolean(this.config.accountId && this.config.apiToken);
  }

  /** Generate one fresh image from one user-provided text prompt. */
  async generate({ prompt }) {
    if (!this.configured()) throw new ImageGenerationNotConfigured();
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) throw new ImageGenerationError('empty image prompt');
    if (cleanPrompt.length > MAX_PROMPT_CHARS) {
      throw new ImageGenerationError(`image prompts must be ${MAX_PROMPT_CHARS.toLocaleString()} characters or fewer.`);
    }

    const url = `${CLOUDFLARE_API_ROOT}/${encodeURIComponent(this.config.accountId)}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`;
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiToken}`,
          'content-type': 'application/json',
        },
        // Four steps is the documented FLUX schnell default: quick enough for
        // a chat command and bounded inside Cloudflare's free daily allowance.
        body: JSON.stringify({ prompt: cleanPrompt, steps: 4 }),
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });
      const result = await imageResult(response, this.config.apiToken);
      this.stats.calls++;
      return { ...result, model: CLOUDFLARE_IMAGE_MODEL };
    } catch (error) {
      this.stats.errors++;
      if (error instanceof ImageGenerationError) throw error;
      const message = String(error?.message || error).split(this.config.apiToken).join('[token]');
      if (/timed out|timeout|aborted/i.test(message)) throw new ImageGenerationError('Cloudflare image generation timed out. Try a shorter prompt in a moment.');
      if (/fetch failed|enotfound|econnrefused|eai_again|network/i.test(message)) throw new ImageGenerationError('The host could not reach Cloudflare Workers AI. Check its internet connection.');
      throw new ImageGenerationError(`Image generation failed: ${message.slice(0, 180)}`);
    }
  }
}

export default ImageGenerationClient;
