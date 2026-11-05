/**
 * Keep health checks responsive after Baileys flushes a buffered upsert batch.
 *
 * A batch may contain a slow item (for example, a view-once download or a
 * provider-backed command) followed by `.ping`. Event handlers intentionally
 * process a batch serially to retain normal command order, so move only the
 * read-only health command to the front. The remaining items preserve their
 * original relative order.
 */
import { extractText } from './message.js';

const HEALTH_COMMANDS = new Set(['ping', 'p', 'latency']);

export function isHealthCheckMessage(raw, prefix = '.') {
  const text = extractText(raw?.message).trim();
  const marker = String(prefix || '.');
  if (!text.startsWith(marker)) return false;
  const command = text.slice(marker.length).trim().split(/\s+/, 1)[0]?.toLowerCase();
  return HEALTH_COMMANDS.has(command);
}

export function prioritizeInboundBatch(messages, prefix = '.') {
  const health = [];
  const ordinary = [];
  for (const raw of Array.isArray(messages) ? messages : []) {
    (isHealthCheckMessage(raw, prefix) ? health : ordinary).push(raw);
  }
  return [...health, ...ordinary];
}

export default prioritizeInboundBatch;
