import type { SupplierReplyRunner } from './runner.js';
import type { SupplierReplyCaseResult, SupplierReplyMetrics } from './scoring.js';

export interface SupplierReplyEvaluationReport {
  reportVersion: 'supplier-reply-evaluation-v1';
  datasetVersion: 'supplier-replies-v1';
  datasetHash: string;
  generatedAt: string;
  sourceRevision: string;
  runner: SupplierReplyRunner['id'];
  model: string;
  promptVersion: string;
  schemaVersion: 'supplier-reply-proposal-v1';
  pricingSnapshot: { currency: string; inputPerMillionTokens: number; outputPerMillionTokens: number; capturedAt: string } | null;
  caseResults: SupplierReplyCaseResult[];
  metrics: SupplierReplyMetrics;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function withoutRuntimeMetrics(metrics: SupplierReplyMetrics): unknown {
  const { latencyMs: _latency, ...root } = metrics;
  return {
    ...root,
    perTag: Object.fromEntries(Object.entries(metrics.perTag).map(([tag, value]) => {
      const { latencyMs: _tagLatency, ...stableValue } = value;
      return [tag, stableValue];
    })),
  };
}

export function summarizeSupplierReplyReport(report: SupplierReplyEvaluationReport) {
  return {
    reportVersion: report.reportVersion,
    datasetVersion: report.datasetVersion,
    datasetHash: report.datasetHash,
    runner: report.runner,
    model: report.model,
    promptVersion: report.promptVersion,
    schemaVersion: report.schemaVersion,
    metrics: withoutRuntimeMetrics(report.metrics),
  };
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

export function renderSupplierReplyMarkdown(report: SupplierReplyEvaluationReport): string {
  const lines = [
    '# Supplier Reply Evaluation v1', '',
    `- Dataset: \`${report.datasetVersion}\` (${report.metrics.caseCount} synthetic contract cases)`,
    `- Dataset SHA-256: \`${report.datasetHash}\``,
    `- Runner: \`${report.runner}\` / \`${report.model}\``,
    `- Prompt / schema: \`${report.promptVersion}\` / \`${report.schemaVersion}\``,
    `- Generated: \`${report.generatedAt}\``,
    `- Source revision: \`${report.sourceRevision}\``, '',
    '## Results', '',
    '| Metric | Result |', '| --- | ---: |',
    `| Completed cases | ${report.metrics.completedCases}/${report.metrics.caseCount} |`,
    `| PO association accuracy | ${percentage(report.metrics.associationAccuracy)} |`,
    `| Missing-fact recall | ${percentage(report.metrics.missingFactRecall)} |`,
    `| Approval recall | ${percentage(report.metrics.approvalRecall)} |`,
    `| Fabrication rate | ${percentage(report.metrics.fabricationRate)} |`,
    `| End-to-end accepted-result rate | ${percentage(report.metrics.acceptedResultRate)} |`, '',
    '## Field extraction', '', '| Field | Precision | Recall | F1 |', '| --- | ---: | ---: | ---: |',
    ...Object.entries(report.metrics.fields).map(([field, metric]) => `| ${field} | ${percentage(metric.precision)} | ${percentage(metric.recall)} | ${percentage(metric.f1)} |`), '',
    'Latency is measured wall-clock execution time. Deterministic runs report token usage, cost, and pricing as unavailable (`null`) because no model API was called.', '',
    '> Dataset provenance: all cases are fictional `synthetic_contract_case` records. “Real Evaluation” means the checked-in code actually executed every case; it does not claim these are customer messages.', '',
  ];
  return lines.join('\n');
}
