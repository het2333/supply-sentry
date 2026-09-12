import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OdooErpClient, OdooPurchaseOrderCancellationRejectedError } from '../src/odoo.js';

type RpcRequest = { model: string; method: string; body: Record<string, unknown> };

function installFakeOdoo(handler: (request: RpcRequest) => unknown | Promise<unknown>): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const [, model, method] = String(input).match(/\/json\/2\/([^/]+)\/([^/?]+)$/) ?? [];
    try {
      const result = await handler({
        model: decodeURIComponent(model ?? ''),
        method: decodeURIComponent(method ?? ''),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      if (result instanceof Response) return result;
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (error) {
      if (error instanceof Response) return error;
      throw error;
    }
  }) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}

const client = () => new OdooErpClient({ baseUrl: 'https://odoo.example.test', database: 'demo', apiKey: 'secret-api-key', timeoutMs: 100 });

test('Odoo PO cancellation calls button_cancel once and returns only after matching readback', async () => {
  let reads = 0;
  let cancellations = 0;
  const restore = installFakeOdoo(({ model, method, body }) => {
    assert.equal(model, 'purchase.order');
    if (method === 'search_read') {
      reads += 1;
      assert.deepEqual(body.domain, [['name', '=', 'P00081']]);
      return [{ id: 81, name: 'P00081', state: reads === 1 ? 'purchase' : 'cancel' }];
    }
    if (method === 'button_cancel') {
      cancellations += 1;
      assert.deepEqual(body, { ids: [81] });
      return true;
    }
    return [];
  });
  try {
    assert.deepEqual(await client().cancelPurchaseOrder('P00081'), {
      id: 81, name: 'P00081', state: 'cancel', replayed: false,
    });
    assert.equal(cancellations, 1);
    assert.equal(reads, 2);
  } finally { restore(); }
});

test('Odoo PO cancellation reconciles an already-cancelled order without issuing another write', async () => {
  let cancellations = 0;
  const restore = installFakeOdoo(({ method }) => {
    if (method === 'search_read') return [{ id: 82, name: 'P00082', state: 'cancel' }];
    if (method === 'button_cancel') cancellations += 1;
    return true;
  });
  try {
    assert.deepEqual(await client().cancelPurchaseOrder('P00082'), {
      id: 82, name: 'P00082', state: 'cancel', replayed: true,
    });
    assert.equal(cancellations, 0);
  } finally { restore(); }
});

test('Odoo PO cancellation classifies a definite business rejection separately from network uncertainty', async () => {
  let reads = 0;
  const restore = installFakeOdoo(({ method }) => {
    if (method === 'search_read') {
      reads += 1;
      return [{ id: 83, name: 'P00083', state: 'purchase' }];
    }
    if (method === 'button_cancel') {
      return new Response(JSON.stringify({ error: 'linked receipt prevents cancellation' }), { status: 409 });
    }
    return true;
  });
  try {
    await assert.rejects(() => client().cancelPurchaseOrder('P00083'), OdooPurchaseOrderCancellationRejectedError);
    assert.equal(reads, 2, 'a rejected write is read back once before it is classified');
  } finally { restore(); }
});
