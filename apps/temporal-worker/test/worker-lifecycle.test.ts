import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTemporalWorkerLifecycle } from '../src/worker-lifecycle.js';

test('Temporal Worker 关闭：信号只停止接单，排空后再回收 AI Runtime 与连接，且重复调用幂等', async () => {
  const calls: string[] = [];
  let drained = false;
  let releaseDrain: (() => void) | undefined;
  const drainedPromise = new Promise<void>((resolve) => { releaseDrain = () => { drained = true; resolve(); }; });
  const lifecycle = createTemporalWorkerLifecycle({
    worker: { async shutdown() { calls.push('worker'); } },
    waitForWorkerDrain: () => drainedPromise,
    agentRuntime: { async close() { calls.push('agent'); } },
    connection: { async close() { calls.push('connection'); } },
  });

  await lifecycle.requestShutdown();
  assert.deepEqual(calls, ['worker']);
  const close = lifecycle.close();
  assert.equal(drained, false);
  releaseDrain!();
  await Promise.all([close, lifecycle.close()]);
  assert.deepEqual(calls, ['worker', 'agent', 'connection']);
});

test('Temporal Worker 关闭：排空失败时仍回收其余资源', async () => {
  const calls: string[] = [];
  const lifecycle = createTemporalWorkerLifecycle({
    worker: { async shutdown() { calls.push('worker'); throw new Error('worker failed'); } },
    waitForWorkerDrain: async () => { calls.push('drain'); },
    agentRuntime: { async close() { calls.push('agent'); } },
    connection: { async close() { calls.push('connection'); } },
  });

  await assert.rejects(lifecycle.close, AggregateError);
  assert.deepEqual(calls, ['worker', 'drain', 'agent', 'connection']);
});
