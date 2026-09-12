import type { TemporalRunState } from '@readywork/temporal-runtime';
import type { EditorRun, EditorStore } from './editor.js';

export interface TemporalStateReader {
  queryState(workflowId: string): Promise<TemporalRunState>;
}

export type TemporalRunReconciliation = 'not_applicable' | 'synced' | 'manual_reconciliation' | 'unavailable';

export interface ReconciledTemporalRun {
  run: EditorRun;
  temporalState?: TemporalRunState;
  reconciliation: TemporalRunReconciliation;
}

const ACTIVE_STATUSES = new Set<EditorRun['status']>(['queued', 'running', 'waiting_approval', 'waiting_external']);

/**
 * Reconcile a persisted control-plane row with Temporal without replaying the
 * workflow or any side effect. Only a definitive missing/closed execution is
 * terminal; connectivity and timeout failures leave the durable row unchanged.
 */
export async function reconcileTemporalRun(store: EditorStore, run: EditorRun, temporal: TemporalStateReader): Promise<ReconciledTemporalRun> {
  if (!run.temporalWorkflowId || !ACTIVE_STATUSES.has(run.status)) return { run, reconciliation: 'not_applicable' };
  try {
    const temporalState = await temporal.queryState(run.temporalWorkflowId);
    const status = temporalState.status;
    const updated = status !== run.status || temporalState.message !== run.message
      ? store.updateRun(run.id, { status, message: temporalState.message })
      : run;
    return { run: updated, temporalState, reconciliation: 'synced' };
  } catch (error) {
    if (!isMissingOrClosedTemporalExecution(error)) return { run, reconciliation: 'unavailable' };
    const summary = 'Temporal 运行已不存在或已关闭；未重放任何节点或外部副作用，需人工对账后决定是否新建运行。';
    const updated = store.updateRun(run.id, { status: 'failed', message: summary });
    store.recordRunReconciliation(run.id, summary);
    return { run: updated, reconciliation: 'manual_reconciliation' };
  }
}

/** Bounded fan-out keeps the reads from becoming a self-inflicted Temporal outage. */
export async function reconcileTemporalRuns(store: EditorStore, runs: EditorRun[], temporal: TemporalStateReader, concurrency = 4): Promise<ReconciledTemporalRun[]> {
  const result: ReconciledTemporalRun[] = new Array(runs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), runs.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= runs.length) return;
      result[index] = await reconcileTemporalRun(store, runs[index]!, temporal);
    }
  });
  await Promise.all(workers);
  return result;
}

function isMissingOrClosedTemporalExecution(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/\b(?:eai_again|enotfound|dns|connection|connect|timeout|timed out|unavailable|deadline)\b/.test(message)) return false;
  return /\bnot_found\b|\bcode\s*[:=]\s*not[ _-]?found\b|workflow execution (?:not found|was not found|closed|already completed|has completed|is closed)/.test(message);
}
