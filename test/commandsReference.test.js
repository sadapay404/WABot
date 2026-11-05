import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(root, 'src', 'plugins');
const referencePath = path.join(root, 'commands.md');

function declaredPluginNames() {
  return fs.readdirSync(pluginDir)
    .filter((file) => file.endsWith('.js') && !file.startsWith('_') && !file.endsWith('.test.js'))
    .flatMap((file) => {
      const source = fs.readFileSync(path.join(pluginDir, file), 'utf8');
      return [...source.matchAll(/\bname:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]);
    })
    .sort();
}

function documentedNames(text) {
  return [...text.matchAll(/^\| `\.([^`]+)` \|/gm)].map((match) => match[1]).sort();
}

test('commands.md exactly inventories the declared runtime commands in alphabetical order', () => {
  const reference = fs.readFileSync(referencePath, 'utf8');
  const pluginNames = declaredPluginNames();
  const names = documentedNames(reference);
  const headline = reference.match(/\*\*(\d+)-command\*\*/);
  const rows = [...reference.matchAll(/^\| `\.([^`]+)` \|/gm)].map((match) => match[1]);

  assert.deepEqual(names, pluginNames);
  assert.equal(Number(headline?.[1]), pluginNames.length);
  assert.deepEqual(rows, [...rows].sort((left, right) => left.localeCompare(right)));
});
