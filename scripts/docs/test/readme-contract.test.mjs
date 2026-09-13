import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const execFileAsync = promisify(execFile);

const requiredAssets = [
  'docs/assets/supplysentry-demo.gif',
  'docs/assets/supplysentry-demo-poster.png',
  'docs/architecture/supplysentry-system.svg',
  'reports/evaluations/supplier-replies-v1.md',
];

const orderedEnglishSections = [
  'Product workflow', 'Measured evaluation', 'Architecture', 'Quick start',
  'Engineering decisions', 'Security boundaries', 'Repository structure',
  'Validation', 'Roadmap', 'License',
];

const orderedChineseSections = [
  '业务流程', '量化评测', '系统架构', '快速开始', '工程决策',
  '安全边界', '仓库结构', '验证', '路线图', '许可证',
];

const assertSectionOrder = (markdown, labels) => {
  let cursor = -1;
  for (const label of labels) {
    const index = markdown.indexOf(`## ${label}`);
    assert.ok(index > cursor, `missing or out-of-order section: ${label}`);
    cursor = index;
  }
};

test('repository landing pages expose the runnable portfolio story in both languages', async () => {
  const [english, chinese] = await Promise.all([read('README.md'), read('README.zh-CN.md')]);

  assert.match(english, /^# SupplySentry \| Evidence-driven procurement execution agent/mu);
  assert.match(english, /\[\u7b80\u4f53\u4e2d\u6587\]\(README\.zh-CN\.md\)/u);
  assert.match(chinese, /^# SupplySentry \| \u8bc1\u636e\u9a71\u52a8\u7684\u91c7\u8d2d\u6267\u884c Agent/mu);
  assert.match(chinese, /\[English\]\(README\.md\)/u);

  for (const badge of ['actions/workflows/ci.yml/badge.svg', 'AGPL--3.0', 'Docker', 'Demo']) {
    assert.match(english, new RegExp(badge, 'u'), `missing badge: ${badge}`);
  }
  assert.match(english, /docs\/assets\/supplysentry-demo\.gif/u);
  assert.match(english, /docs\/assets\/supplysentry-demo-poster\.png/u);
  assert.match(english, /Try Online/u);
  assert.match(english, /Run Locally/u);
  assert.match(english, /Durable workflow/u);
  assert.match(english, /Controlled side effects/u);
  assert.match(english, /Measured reliability/u);

  assertSectionOrder(english, orderedEnglishSections);
  assertSectionOrder(chinese, orderedChineseSections);
});

test('README evidence matches the executed evaluation and public-demo boundaries', async () => {
  const [english, chinese, reportText] = await Promise.all([
    read('README.md'),
    read('README.zh-CN.md'),
    read('reports/evaluations/supplier-replies-v1.json'),
  ]);
  const report = JSON.parse(reportText);
  const facts = [
    `${report.metrics.completedCases}/${report.metrics.caseCount}`,
    '100.00%',
    '0.00%',
    report.datasetHash,
  ];

  for (const markdown of [english, chinese]) {
    for (const fact of facts) assert.ok(markdown.includes(fact), `missing measured fact: ${fact}`);
    assert.match(markdown, /synthetic_contract_case/u);
    assert.match(markdown, /deterministic/u);
    assert.match(markdown, /DeepSeek evaluation: not published/u);
    assert.match(markdown, /simulated_demo/u);
    assert.match(markdown, /externalDelivery=false/u);
    assert.match(markdown, /\.\/scripts\/demo\/demo\.sh up --build/u);
    assert.doesNotMatch(markdown, /DeepSeek[^\n|]*100\.00%/u);
  }
});

test('README-linked portfolio assets exist in the repository', async () => {
  await Promise.all(requiredAssets.map((path) => access(new URL(path, root))));
});

test('README verifier checks local links and reports measured facts', async () => {
  const verifier = new URL('../verify-readme.mjs', import.meta.url);
  const { stdout } = await execFileAsync(process.execPath, [fileURLToPath(verifier), '--local']);
  const result = JSON.parse(stdout);
  assert.deepEqual(result, {
    ok: true,
    languages: 2,
    completedCases: 240,
    datasetHash: '4452a076d5d0ea7d0de01fee9ea77007976db0d038b718bda2378c455399b331',
    localLinks: result.localLinks,
    external: 'skipped',
  });
  assert.ok(result.localLinks >= 20);
});
