/**
 * Minimal .env writer: replaces one KEY=value line or appends it. Leaves every
 * other line, comment and blank line untouched. The file is written 0600
 * because it holds API keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = path.resolve(HERE, '..', '..', '.env');

export function setEnvValue(key, value, file = ENV_PATH) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid env key: ${key}`);
  if (/[\r\n]/.test(String(value))) throw new Error('env value must be a single line');

  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = existing.length ? existing.replace(/\n$/, '').split('\n') : [];
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let found = false;
  const out = lines.map((line) => {
    if (!pattern.test(line)) return line;
    if (found) return null; // drop duplicate definitions
    found = true;
    return `${key}=${value}`;
  }).filter((line) => line !== null);
  if (!found) out.push(`${key}=${value}`);

  fs.writeFileSync(file, `${out.join('\n')}\n`, { mode: 0o600 });
  return file;
}
