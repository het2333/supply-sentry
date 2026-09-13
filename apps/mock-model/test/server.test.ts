import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMockModelServer } from '../src/index.js';

test('deterministic mock model exposes health and accepts an explicit container bind address', async () => {
  const server = await createMockModelServer({ host: '127.0.0.1', port: 0 });
  try {
    const health = await fetch(`${server.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, service: 'readywork-mock-model', deterministic: true });

    const completion = await fetch(`${server.url}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stream: false, messages: [{ role: 'user', content: '[任务指令] 查看状态' }] }),
    });
    assert.equal(completion.status, 200);
    assert.equal(server.requestCount(), 1);
  } finally { await server.close(); }
});
