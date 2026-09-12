import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const apiSource = readFileSync(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8');
const chatSource = readFileSync(fileURLToPath(new URL('../src/chat.ts', import.meta.url)), 'utf8');
const consoleSource = readFileSync(fileURLToPath(new URL('../../console/app/page.tsx', import.meta.url)), 'utf8');
const legacyApiLandingPage = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

test('production runtime: an empty database stays empty and cannot receive synthetic business events', () => {
  assert.doesNotMatch(apiSource, /async function seed\(/);
  assert.doesNotMatch(apiSource, /await seed\(\)/);
  assert.doesNotMatch(apiSource, /\/api\/events\/inject/);
  assert.doesNotMatch(apiSource, /seedSupplierEmail|seedGoodsReceived|supplier@demo\.cn/);
  assert.doesNotMatch(apiSource, /s1@supplier\.cn|onTimeOf|nameOf:\s*Record/);
  assert.match(apiSource, /空数据库保持真实空态/);
});

test('production Web and chat do not expose hardcoded PO event injection', () => {
  assert.doesNotMatch(chatSource, /inject_event/);
  assert.doesNotMatch(consoleSource, /\/api\/events\/inject/);
  assert.doesNotMatch(consoleSource, /objectId:\s*["']po:1001["']/);
});

test('production API landing surfaces expose the Readywork brand only', () => {
  for (const [name, surface] of [
    ['runtime landing page', apiSource],
    ['legacy redirect page', legacyApiLandingPage],
  ] as const) {
    assert.doesNotMatch(surface, /ReadyCrew/i, name);
    assert.match(surface, /Readywork/i, name);
  }
});
