#!/usr/bin/env node

import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const readmes = ['README.md', 'README.zh-CN.md'];

const localTargets = (markdown) => {
  const targets = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)) targets.push(match[1]);
  for (const match of markdown.matchAll(/(?:src|srcset)="([^"]+)"/gu)) targets.push(match[1]);
  return targets
    .map((target) => target.trim().split(/\s+/u)[0])
    .filter((target) => target && !target.startsWith('#') && !/^[a-z][a-z\d+.-]*:/iu.test(target))
    .map((target) => decodeURIComponent(target.split('#')[0].split('?')[0]));
};

const [english, chinese, reportText] = await Promise.all([
  read(readmes[0]),
  read(readmes[1]),
  read('reports/evaluations/supplier-replies-v1.json'),
]);
const report = JSON.parse(reportText);

assert.equal(report.runner, 'deterministic');
assert.equal(report.metrics.completedCases, 240);
assert.equal(report.metrics.caseCount, 240);
assert.equal(report.metrics.fabricationRate, 0);

for (const markdown of [english, chinese]) {
  assert.ok(markdown.includes(`${report.metrics.completedCases}/${report.metrics.caseCount}`));
  assert.ok(markdown.includes(report.datasetHash));
  assert.ok(markdown.includes('DeepSeek evaluation: not published'));
  assert.ok(markdown.includes('simulated_demo'));
  assert.ok(markdown.includes('externalDelivery=false'));
}

const targets = [...localTargets(english), ...localTargets(chinese)];
await Promise.all(targets.map((target) => access(new URL(target, root))));

const result = {
  ok: true,
  languages: readmes.length,
  completedCases: report.metrics.completedCases,
  datasetHash: report.datasetHash,
  localLinks: targets.length,
  external: 'skipped',
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
