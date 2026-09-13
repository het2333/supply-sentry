import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeepSeekSupplierReplyRunner } from '../src/supplier-replies/deepseek-runner.js';
import { generateSupplierReplyDataset } from '../../../scripts/evals/generate-supplier-reply-dataset.js';

const sample = generateSupplierReplyDataset()[0]!;
const apiKey = 'test-only-deepseek-key-never-serialize';

function success(prediction: unknown = sample.expected, usage = { prompt_tokens: 31, completion_tokens: 17 }) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(prediction) } }], usage }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('requests structured JSON with a bounded signal and records only normalized output plus actual usage', async () => {
  let request: RequestInit | undefined;
  const runner = createDeepSeekSupplierReplyRunner({
    apiKey, model: 'deepseek-test', timeoutMs: 4321,
    fetch: async (_url, init) => { request = init; return success(); },
  });
  const output = await runner.run({ case: sample });
  const body = JSON.parse(String(request?.body));
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.model, 'deepseek-test');
  assert.ok(request?.signal instanceof AbortSignal);
  assert.equal((request?.headers as Record<string, string>).authorization, `Bearer ${apiKey}`);
  assert.deepEqual(output.prediction, sample.expected);
  assert.equal(output.metadata.inputTokens, 31);
  assert.equal(output.metadata.outputTokens, 17);
  assert.equal(output.metadata.cost, null);
  assert.equal(JSON.stringify(output).includes(apiKey), false);
  assert.equal(JSON.stringify(output).includes('choices'), false);
});

test('retries 429 and server failures but not authentication failures', async () => {
  let retryCalls = 0;
  const retrying = createDeepSeekSupplierReplyRunner({
    apiKey, retries: 2, sleep: async () => {},
    fetch: async () => {
      retryCalls += 1;
      if (retryCalls === 1) return new Response('{"error":{"message":"quota body must stay private"}}', { status: 429 });
      if (retryCalls === 2) return new Response('upstream internal details', { status: 503 });
      return success();
    },
  });
  assert.deepEqual((await retrying.run({ case: sample })).prediction, sample.expected);
  assert.equal(retryCalls, 3);

  let authCalls = 0;
  const auth = createDeepSeekSupplierReplyRunner({ apiKey, retries: 3, fetch: async () => { authCalls += 1; return new Response('secret provider body', { status: 401 }); } });
  await assert.rejects(auth.run({ case: sample }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /authentication failed/i.test(message) && !message.includes(apiKey) && !message.includes('secret provider body');
  });
  assert.equal(authCalls, 1);

  const invalidRequest = createDeepSeekSupplierReplyRunner({ apiKey, fetch: async () => new Response('private validation details', { status: 400 }) });
  await assert.rejects(invalidRequest.run({ case: sample }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /HTTP 400/u.test(message) && !message.includes('private validation details');
  });
});

test('retries invalid structured output once and never returns the raw provider response', async () => {
  let calls = 0;
  const runner = createDeepSeekSupplierReplyRunner({
    apiKey, retries: 1, sleep: async () => {},
    fetch: async () => { calls += 1; return calls === 1 ? success({ association: 'broken' }) : success(); },
  });
  const output = await runner.run({ case: sample });
  assert.equal(calls, 2);
  assert.deepEqual(output.prediction, sample.expected);
  assert.equal(JSON.stringify(output).includes('broken'), false);
});

test('retries transport errors within the configured bound and sanitizes final failures', async () => {
  let calls = 0;
  const runner = createDeepSeekSupplierReplyRunner({
    apiKey, retries: 1, sleep: async () => {},
    fetch: async () => { calls += 1; throw new Error(`socket failed ${apiKey}`); },
  });
  await assert.rejects(runner.run({ case: sample }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return /temporarily unavailable/i.test(message) && !message.includes(apiKey) && !message.includes('socket failed');
  });
  assert.equal(calls, 2);
});
