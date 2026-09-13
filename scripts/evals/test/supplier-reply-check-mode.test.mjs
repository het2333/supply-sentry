import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(decodeURIComponent(new URL('../../..', import.meta.url).pathname));
const reportPaths = [
  resolve(root, 'reports/evaluations/supplier-replies-v1.json'),
  resolve(root, 'reports/evaluations/supplier-replies-v1.md'),
];
const digest = (value) => createHash('sha256').update(value).digest('hex');

test('supplier reply check mode never rewrites the published reports', async () => {
  const before = await Promise.all(reportPaths.map(async (path) => digest(await readFile(path))));
  const result = spawnSync('pnpm', ['exec', 'tsx', 'apps/evals/src/supplier-replies.ts', '--runner', 'deterministic', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const after = await Promise.all(reportPaths.map(async (path) => digest(await readFile(path))));
  assert.deepEqual(after, before);
});
