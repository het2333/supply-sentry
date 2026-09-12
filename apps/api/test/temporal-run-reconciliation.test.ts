import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { TemporalRunState } from '@readywork/temporal-runtime';
import { EditorStore, type EditorRun } from '../src/editor.js';
import { reconcileTemporalRun, reconcileTemporalRuns } from '../src/temporal-run-reconciliation.js';

function activeRun(id: string): EditorRun {
  return {
    id, workflowId: 'procurement-orchestrator', workflowName: '采购路径编排', mode: 'autonomous', status: 'running', sideEffects: 'enabled', decision: {},
    message: '已提交 Temporal', createdAt: '2026-08-20T00:00:00.000Z', temporalWorkflowId: `readywork:tenant:ai:${id}`, runtime: 'temporal',
  };
}

function state(status: TemporalRunState['status'], message: string): TemporalRunState {
  return { runId: 'run', status, visitedNodeIds: [], message };
}

test('Temporal 运行对账：活跃运行同步状态，不重启或重放业务节点', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new EditorStore(db);
  store.recordRun(activeRun('run:active'));
  let calls = 0;
  const result = await reconcileTemporalRun(store, store.getRun('run:active')!, { queryState: async () => { calls += 1; return state('waiting_approval', '等待财务审批'); } });
  assert.equal(calls, 1);
  assert.equal(result.reconciliation, 'synced');
  assert.equal(result.run.status, 'waiting_approval');
  assert.equal(store.listBusinessActivities('run:active').length, 0);
  db.close();
});

test('Temporal 运行对账：仅确定性不存在/关闭才标记 failed + 人工对账审计', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new EditorStore(db);
  store.recordRun(activeRun('run:missing'));
  const result = await reconcileTemporalRun(store, store.getRun('run:missing')!, { queryState: async () => { throw new Error('Workflow execution not found (NOT_FOUND)'); } });
  assert.equal(result.reconciliation, 'manual_reconciliation');
  assert.equal(result.run.status, 'failed');
  assert.match(result.run.message, /未重放/);
  const audit = store.listBusinessActivities('run:missing');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.type, 'run.manual_reconciliation');
  // A second list/detail read is idempotent and does not invent another audit event.
  const repeated = await reconcileTemporalRun(store, store.getRun('run:missing')!, { queryState: async () => { throw new Error('should not query terminal row'); } });
  assert.equal(repeated.reconciliation, 'not_applicable');
  assert.equal(store.listBusinessActivities('run:missing').length, 1);
  db.close();
});

test('Temporal 运行对账：连接/超时故障保持原状态，批量读取有界且保序', async () => {
  const db = new DatabaseSync(':memory:');
  const store = new EditorStore(db);
  for (const id of ['run:one', 'run:two', 'run:three']) store.recordRun(activeRun(id));
  const results = await reconcileTemporalRuns(store, store.listRuns(10), { queryState: async () => { throw new Error('Temporal connection timeout'); } }, 2);
  assert.deepEqual(results.map((item) => item.reconciliation), ['unavailable', 'unavailable', 'unavailable']);
  assert.equal(store.listRuns(10).every((run) => run.status === 'running'), true);
  db.close();
});
