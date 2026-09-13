import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDeterministicSupplierReplyRunner,
  loadSupplierReplyDataset,
  renderSupplierReplyMarkdown,
  scoreSupplierReplyCases,
  stableJson,
  summarizeSupplierReplyReport,
  verifySupplierReplyDataset,
  type SupplierReplyCaseResult,
  type SupplierReplyEvaluationReport,
  type SupplierReplyRunner,
} from '@readywork/evals';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function revision(): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unavailable'; }
}

async function runnerFor(id: string): Promise<SupplierReplyRunner> {
  if (id === 'deterministic') return createDeterministicSupplierReplyRunner();
  if (id === 'deepseek') {
    const optionalRunnerModule = '../../../packages/evals/src/supplier-replies/deepseek-runner.js';
    const module = await import(optionalRunnerModule) as { createDeepSeekSupplierReplyRunnerFromEnvironment(): SupplierReplyRunner };
    return module.createDeepSeekSupplierReplyRunnerFromEnvironment();
  }
  throw new Error(`Unsupported supplier reply runner: ${id}`);
}

async function runConcurrent<T, R>(items: readonly T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await task(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return output;
}

export async function runSupplierReplyEvaluation(args: {
  runnerId: string;
  datasetPath: string;
  digestPath: string;
  reportDirectory: string;
  concurrency: number;
}): Promise<SupplierReplyEvaluationReport> {
  const { cases, sourceBytes } = await loadSupplierReplyDataset(args.datasetPath);
  const expectedDigest = (await readFile(args.digestPath, 'utf8')).trim();
  const dataset = verifySupplierReplyDataset(cases, sourceBytes, { expectedDigest });
  const runner = await runnerFor(args.runnerId);
  const caseResults = await runConcurrent(cases, args.concurrency, async (value): Promise<SupplierReplyCaseResult> => {
    const result = await runner.run({ case: value });
    return { caseId: value.caseId, scenarioTags: [...value.scenarioTags], expected: value.expected, prediction: result.prediction, metadata: result.metadata };
  });
  caseResults.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const report: SupplierReplyEvaluationReport = {
    reportVersion: 'supplier-reply-evaluation-v1', datasetVersion: 'supplier-replies-v1', datasetHash: dataset.digest,
    generatedAt: new Date().toISOString(), sourceRevision: revision(), runner: runner.id, model: runner.model,
    promptVersion: runner.promptVersion, schemaVersion: runner.schemaVersion, pricingSnapshot: null,
    caseResults, metrics: scoreSupplierReplyCases(caseResults),
  };
  await mkdir(args.reportDirectory, { recursive: true });
  await writeFile(resolve(args.reportDirectory, 'supplier-replies-v1.json'), stableJson(report));
  await writeFile(resolve(args.reportDirectory, 'supplier-replies-v1.md'), renderSupplierReplyMarkdown(report));
  return report;
}

async function main(): Promise<void> {
  const runnerId = option('--runner', 'deterministic')!;
  const datasetPath = resolve(option('--dataset', resolve(repositoryRoot, 'evals/supplier-replies/v1/dataset.jsonl'))!);
  const digestPath = resolve(dirname(datasetPath), 'dataset.sha256');
  const check = process.argv.includes('--check');
  const publishedReportDirectory = resolve(option('--report-dir', resolve(repositoryRoot, 'reports/evaluations'))!);
  const temporaryReportDirectory = check ? await mkdtemp(resolve(tmpdir(), 'supplysentry-eval-check-')) : null;
  const reportDirectory = temporaryReportDirectory ?? publishedReportDirectory;
  const concurrency = Number(option('--concurrency', runnerId === 'deepseek' ? '1' : '8'));
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('--concurrency must be an integer from 1 to 32');
  try {
    const report = await runSupplierReplyEvaluation({ runnerId, datasetPath, digestPath, reportDirectory, concurrency });
    const summary = summarizeSupplierReplyReport(report);
    const expectedPath = resolve(dirname(datasetPath), 'expected-summary.json');
    if (process.argv.includes('--write-expected')) await writeFile(expectedPath, stableJson(summary));
    if (check) {
      const expected = await readFile(expectedPath, 'utf8');
      const actual = stableJson(summary);
      if (actual !== expected) throw new Error('Deterministic supplier reply summary differs from expected-summary.json');
    }
    console.log(JSON.stringify({ cases: report.metrics.caseCount, completed: report.metrics.completedCases, datasetHash: report.datasetHash, runner: report.runner, associationAccuracy: report.metrics.associationAccuracy, acceptedResultRate: report.metrics.acceptedResultRate, fabricationRate: report.metrics.fabricationRate }));
  } finally {
    if (temporaryReportDirectory) await rm(temporaryReportDirectory, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9]{8,}/gu, '[REDACTED]') : 'Supplier reply evaluation failed');
  process.exit(1);
});
