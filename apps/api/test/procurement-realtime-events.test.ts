import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PurchaseOrder } from '@readywork/core';
import { openPersistence } from '@readywork/persistence';
import type { Session } from '../src/auth.js';
import {
  handleProcurementRealtimeEventsRequest,
  latestProcurementRealtimeEventSeq,
  listProcurementRealtimeEvents,
  realtimeCursor,
} from '../src/procurement-realtime-events.js';

const at = '2026-08-30T10:00:00.000Z';

function purchaseOrder(tenantId: string, id: string): PurchaseOrder {
  return {
    id, tenantId, sourceSystem: 'odoo', externalId: `external:${id}`, status: 'sent',
    createdAt: at, updatedAt: at, supplierId: `supplier:${id}`, currency: 'CNY', orderedAt: at,
  };
}

function session(tenantId: string): Session {
  return { username: `buyer:${tenantId}`, tenantId, humanId: `human:${tenantId}`, name: '采购人员', role: '采购专员', expiresAt: Date.now() + 60_000 };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, predicate: (text: string) => boolean): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const timeout = setTimeout(() => { void reader.cancel('timeout'); }, 3_000);
  try {
    while (!predicate(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

test('采购实时事件：触发器、租户隔离、SSE 重放与实时续传', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-realtime-events-'));
  const databasePath = join(directory, 'events.sqlite');
  const tenantA = 'tenant:realtime-a';
  const tenantB = 'tenant:realtime-b';
  const store = openPersistence(databasePath, { tenantId: tenantA });
  const otherStore = openPersistence(databasePath, { tenantId: tenantB });
  const poA = purchaseOrder(tenantA, 'po:realtime-a');
  const poB = purchaseOrder(tenantB, 'po:realtime-b');

  store.procurement.saveDocument('purchase_order', poA);
  otherStore.procurement.saveDocument('purchase_order', poB);
  store.db.prepare(`INSERT INTO procurement_outbox
    (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenantA, 'outbox:realtime', 'email', 'email', 'purchase_order.send', poA.id,
      'realtime-outbox', 'pending', '{}', '{}', at, at,
    );
  store.db.prepare(`INSERT INTO procurement_message_drafts
    (tenant_id,id,purchase_order_id,supplier_id,channel,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenantA, 'draft:realtime', poA.id, 'supplier:realtime', 'email', 'supplier@example.test',
      'PO 跟进', '测试正文不会进入实时事件', 'acknowledgement_followup', 'trigger:realtime', '{}',
      'draft', 1, 'human:buyer', at, at,
    );
  store.db.prepare(`INSERT INTO procurement_notifications
    (tenant_id,id,fingerprint,type,severity,title,message,tag,object_type,object_id,evidence_json,status,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      tenantA, 'notification:realtime', 'fingerprint:realtime', 'po_changed', 'info', 'PO 已变化',
      '通知正文不会进入实时事件', 'PO', 'purchase_order', poA.id, '{}', 'unread', 1, at, at,
    );

  const families = listProcurementRealtimeEvents(store.db, tenantA, 0, 20).map((event) => event.family);
  assert.deepEqual(new Set(families), new Set(['pos', 'outbox', 'messages', 'notifications']));
  const serialized = JSON.stringify(listProcurementRealtimeEvents(store.db, tenantA, 0, 20));
  assert.equal(serialized.includes('测试正文不会进入实时事件'), false);
  assert.equal(serialized.includes(poB.id), false);
  assert.ok(latestProcurementRealtimeEventSeq(store.db, tenantA) > 0);
  assert.equal(realtimeCursor('0'), 0);
  assert.throws(() => realtimeCursor('-1'), /非负整数/);

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const activeSession = req.headers.authorization === 'Bearer tenant-a' ? session(tenantA) : null;
    void handleProcurementRealtimeEventsRequest(req, res, path, req.method ?? 'GET', {
      db: store.db, session: activeSession, pollIntervalMs: 20, heartbeatIntervalMs: 1_000, maxReplayEvents: 50,
    }).then((handled) => { if (!handled) res.writeHead(404).end(); }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const unauthorized = await fetch(`${base}/api/events?stream=1`);
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(`${base}/api/events?stream=1&cursor=bad`, { headers: { authorization: 'Bearer tenant-a' } });
    assert.equal(invalid.status, 400);

    const replayResponse = await fetch(`${base}/api/events?stream=1&cursor=0`, {
      headers: { accept: 'text/event-stream', authorization: 'Bearer tenant-a' },
    });
    assert.equal(replayResponse.status, 200);
    assert.match(replayResponse.headers.get('content-type') ?? '', /text\/event-stream/);
    const replayReader = replayResponse.body!.getReader();
    const replay = await readUntil(replayReader, (text) => text.includes('event: notifications'));
    assert.match(replay, /event: ready/);
    assert.match(replay, /event: pos/);
    assert.match(replay, /event: outbox/);
    assert.match(replay, /event: messages/);
    assert.match(replay, /event: notifications/);
    assert.equal(replay.includes(poB.id), false);
    await replayReader.cancel();

    const liveResponse = await fetch(`${base}/api/events?stream=1`, {
      headers: { accept: 'text/event-stream', authorization: 'Bearer tenant-a' },
    });
    const liveReader = liveResponse.body!.getReader();
    const ready = await readUntil(liveReader, (text) => text.includes('event: ready'));
    assert.match(ready, /event: ready/);
    const changedAt = '2026-08-30T10:01:00.000Z';
    store.db.prepare(`UPDATE procurement_notifications SET status='read',version=2,updated_at=?
      WHERE tenant_id=? AND id=?`).run(changedAt, tenantA, 'notification:realtime');
    const live = await readUntil(liveReader, (text) => text.includes('notification.changed'));
    assert.match(live, /event: notifications/);
    assert.match(live, /notification\.changed/);
    await liveReader.cancel();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    otherStore.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
