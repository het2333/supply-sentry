#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? 'artifacts/media/supplysentry-demo');
const manifest = JSON.parse(await readFile(resolve(directory, 'capture-manifest.json'), 'utf8'));
const forbidden = /47\.102\.116\.148|novagent|t:acme|@qq\.com|sk-[a-z0-9]{12,}|authorization|password|cookie|session[_-]?secret/i;

assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.tenantId, 't:public-demo');
assert.deepEqual(manifest.viewport, { width: 1440, height: 900 });
assert.ok(['127.0.0.1', 'localhost'].includes(manifest.baseHost));
assert.ok(manifest.durationSeconds >= 60 && manifest.durationSeconds <= 90);
assert.ok(Array.isArray(manifest.scenes) && manifest.scenes.length >= 7);
assert.equal(manifest.scenes.every((scene) => scene.tenantId === 't:public-demo' && scene.bannerVisible === true), true);
assert.doesNotMatch(JSON.stringify(manifest), forbidden);

for (const scene of manifest.scenes) {
  assert.match(scene.file, /^scene-\d{2}\.png$/u);
  const file = resolve(directory, scene.file);
  await access(file);
  assert.ok((await stat(file)).size > 20_000, `${scene.file} is unexpectedly small`);
}

await access(resolve(directory, 'poster.png'));
await access(resolve(directory, 'frames.ffconcat'));
console.log(JSON.stringify({ ok: true, scenes: manifest.scenes.length, durationSeconds: manifest.durationSeconds, privacy: 'pass', tenantId: manifest.tenantId }, null, 2));
