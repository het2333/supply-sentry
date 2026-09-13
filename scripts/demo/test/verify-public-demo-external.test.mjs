import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(decodeURIComponent(new URL('../../..', import.meta.url).pathname));

test('external verification needs no internal token and never calls the reset endpoint', async () => {
  const requests = [];
  let notificationUnread = 1;
  let riskRecorded = false;
  let approvalStatus = 'pending';
  const po = { id: 'purchase-order:public-demo:awaiting-confirmation', version: 1, status: 'awaiting_confirmation' };
  const partialPo = { id: 'purchase-order:public-demo:partial', version: 1 };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: request.method, path: url.pathname });
    let status = 200;
    let body = {};

    if (url.pathname === '/') body = '<!doctype html><title>SupplySentry</title>';
    else if (url.pathname === '/api/auth/public-demo') {
      response.setHeader('set-cookie', 'readywork_session=rw1.external-test; HttpOnly; Path=/');
      body = { demoMode: true };
    } else if (url.pathname === '/api/public-demo/status') {
      body = { tenantId: 't:public-demo', seedVersion: 'public-demo-v1', status: 'healthy', generation: 9 };
    } else if (url.pathname === '/api/procurement/workbench') {
      body = {
        documents: { purchaseOrders: { items: [po, partialPo] } },
        exceptions: { items: riskRecorded ? [{ objectId: po.id, type: 'manual_purchase_order_risk' }] : [] },
        recentActivities: { items: riskRecorded ? [{ objectId: po.id, action: 'purchase_order.marked_at_risk' }] : [] },
      };
    } else if (url.pathname === '/api/procurement/notifications') {
      body = { counts: { unread: notificationUnread } };
    } else if (url.pathname === '/api/procurement/notifications/read-all' && request.headers['x-readywork-demo-generation'] === '8') {
      status = 409;
      body = { code: 'DEMO_GENERATION_CONFLICT', currentGeneration: 9 };
    } else if (url.pathname === '/api/procurement/notifications/read-all') {
      notificationUnread = 0;
      body = { counts: { unread: 0 } };
    } else if (url.pathname === '/api/procurement/execution/mark_at_risk') {
      riskRecorded = true;
      status = 201;
      body = { exception: { objectId: po.id, type: 'manual_purchase_order_risk' } };
    } else if (url.pathname === '/api/procurement/execution/approvals/approval%3Apublic-demo%3Ashort-delivery') {
      body = { approval: { id: 'approval:public-demo:short-delivery', poId: po.id, status: approvalStatus } };
    } else if (url.pathname === '/api/procurement/execution/decide_confirmation') {
      approvalStatus = 'approved';
      po.status = 'confirmed';
      po.version = 2;
      status = 201;
      body = {
        approval: { id: 'approval:public-demo:short-delivery', status: 'approved', shortfallDisposition: 'cancel_remainder' },
        aggregate: { document: { id: po.id, status: 'confirmed' }, version: 2 },
      };
    } else if (url.pathname === '/api/public-demo/simulated-actions') {
      body = { output: { receiptKind: 'simulated_demo', externalDelivery: false, generation: 9 } };
    } else if (url.pathname.startsWith('/api/editor/') || url.pathname.startsWith('/api/procurement/import-documents/') || url.pathname.startsWith('/api/connectors/')) {
      status = 403;
      body = { code: 'PUBLIC_DEMO_CAPABILITY_DISABLED' };
    } else if (url.pathname === '/internal/demo/reset') {
      status = 500;
      body = { error: 'external verifier must not call reset' };
    } else {
      status = 404;
      body = { error: `unhandled test route ${url.pathname}` };
    }

    response.statusCode = status;
    if (typeof body === 'string') response.end(body);
    else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const child = spawn(process.execPath, [
      resolve(root, 'scripts/demo/verify-public-demo.mjs'),
      '--base-url',
      `http://127.0.0.1:${address.port}`,
    ], {
      cwd: root,
      env: { ...process.env, READYWORK_INTERNAL_CALLBACK_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const [exitCode] = await once(child, 'exit');

    assert.equal(exitCode, 0, stderr || stdout);
    assert.match(stdout, /"verificationMode": "external_public"/u);
    assert.match(stdout, /"approval": "approved"/u);
    assert.match(stdout, /"resetVerification": "server_internal_only"/u);
    assert.equal(requests.some((request) => request.path === '/internal/demo/reset'), false);
    assert.equal(requests.some((request) => request.path === '/api/procurement/execution/decide_confirmation'), true);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
