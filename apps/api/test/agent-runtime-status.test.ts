import assert from 'node:assert/strict';
import test from 'node:test';
import { describeAgentRuntime, describeTemporalWorkerRuntime } from '../src/agent-runtime-status.js';

test('describes the actual in-process runtime without claiming subprocess isolation', () => {
  const status = describeAgentRuntime({ constructor: { name: 'InMemoryAgentAdapter' } }, {});
  assert.equal(status.runtime, 'inmemory');
  assert.equal(status.provider, 'inmemory');
  assert.equal(status.model, 'inmemory-deterministic');
  assert.equal(status.readiness, 'ready');
  assert.equal(status.isolation, 'in_process');
});

test('exposes harness health metadata while redacting credential-bearing diagnostics', () => {
  const status = describeAgentRuntime({
    constructor: { name: 'AgentRuntimeManager' },
    getDescription: () => ({ kind: 'dsh', implementation: 'DeepSeekHarnessAdapter', provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
    getHealth: () => ({ status: 'unhealthy', detail: 'request failed with api_key=super-secret' }),
  }, { DEEPSEEK_API_KEY: 'super-secret' });
  assert.equal(status.runtime, 'deepseek-harness');
  assert.equal(status.provider, 'deepseek-official');
  assert.equal(status.model, 'deepseek-v4-flash');
  assert.equal(status.readiness, 'error');
  assert.equal(status.isolation, 'subprocess');
  assert.match(status.error ?? '', /\[REDACTED\]/);
  assert.ok(!JSON.stringify(status).includes('super-secret'));
});

test('describes the Temporal worker target, not the legacy API agent', () => {
  const status = describeTemporalWorkerRuntime({ READYWORK_AGENT_RUNTIME: 'inmemory' });
  assert.equal(status.runtime, 'inmemory');
  assert.equal(status.source, 'temporal-worker-config');
  assert.equal(status.observed, false);
  assert.equal(status.readiness, 'not_observed');
  assert.equal(status.available, false);
});

test('reports a valid target as ready only after a Temporal Task Queue poller is observed', () => {
  const status = describeTemporalWorkerRuntime({ READYWORK_AGENT_RUNTIME: 'inmemory' }, { workerObserved: true });
  assert.equal(status.runtime, 'inmemory');
  assert.equal(status.readiness, 'ready');
  assert.equal(status.status, 'ready');
  assert.equal(status.available, true);
  assert.equal(status.observed, true);
});

test('does not report a missing default DSH checkout as ready', () => {
  const repo = '/Users/etheralia/private/deepseek-harness';
  const status = describeTemporalWorkerRuntime({ READYWORK_AGENT_RUNTIME: 'dsh', READYWORK_DSH_REPO: repo, READYWORK_DSH_COMMAND: '/Users/etheralia/private/bin/dsh' });
  assert.equal(status.runtime, 'deepseek-harness');
  assert.equal(status.configuration, 'invalid');
  assert.equal(status.readiness, 'unconfigured');
  assert.equal(status.observed, false);
  assert.ok(status.error);
  assert.ok(!status.error!.includes(repo));
  assert.ok(!status.error!.includes('/Users/etheralia/private/bin/dsh'));
});

test('observed Worker readiness wins over unavailable control-plane private config', () => {
  const status = describeTemporalWorkerRuntime({ READYWORK_AGENT_RUNTIME: 'dsh' }, { workerObserved: true });
  assert.equal(status.runtime, 'deepseek-harness');
  assert.equal(status.configuration, 'valid');
  assert.equal(status.readiness, 'ready');
  assert.equal(status.available, true);
  assert.equal(status.observed, true);
  assert.match(status.note ?? '', /不读取 Worker 私有配置/);
  assert.equal(status.error, undefined);
});
