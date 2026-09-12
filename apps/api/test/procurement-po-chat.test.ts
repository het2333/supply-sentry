import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { MemoryAttachmentObjectStorage } from '../src/attachment-object-storage.js';
import { handleProcurementPoChatRequest, routePoChatModel, type PoChatModelInput } from '../src/procurement-po-chat.js';

const SESSION_SECRET = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
const at = '2026-08-30T00:00:00.000Z';

function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
}

function token(tenantId: string, humanId: string): string {
  return signSession({ username: humanId, tenantId, humanId, name: humanId, role: '采购专员', expiresAt: Date.now() + 60_000 });
}

function seed(store: ReturnType<typeof openPersistence>, tenantId: string, suffix: string): string {
  const supplier: Supplier = {
    id: `supplier:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `SUP-${suffix}`, status: 'active',
    createdAt: at, updatedAt: at, name: `供应商 ${suffix}`, currency: 'CNY', performanceScore: 96,
    contacts: [{ id: `contact:${suffix}`, name: '业务联系人', primary: true }],
  };
  const po: PurchaseOrder = {
    id: `po:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `purchase.order:${suffix}`, status: 'awaiting_confirmation',
    createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at,
  };
  const line: PurchaseOrderLine = {
    id: `po-line:${suffix}`, poId: po.id, lineNumber: '10', itemId: `item:${suffix}`, description: `真实物料 ${suffix}`,
    uom: 'EA', orderedQty: 12, unitPrice: 18.5, currency: 'CNY', requestedAt: '2026-09-10T00:00:00.000Z',
  };
  store.procurement.saveDocument('supplier', supplier);
  store.procurement.saveDocument('purchase_order', po);
  store.procurement.saveLine('purchase_order_line', po.id, line);
  return po.id;
}

test('PO 上下文聊天：持久化历史、租户/用户隔离、幂等、附件门禁和模型路由', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-po-chat-'));
  const databasePath = join(directory, 'chat.sqlite');
  const store = openPersistence(databasePath, { tenantId: 'tenant:a' });
  const tenantBStore = openPersistence(databasePath, { tenantId: 'tenant:b' });
  const poA = seed(store, 'tenant:a', 'a');
  const poB = seed(tenantBStore, 'tenant:b', 'b');
  const storage = new MemoryAttachmentObjectStorage();
  const modelCalls: PoChatModelInput[] = [];
  const server = createServer((req, res) => {
    const authorization = req.headers['authorization'];
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleProcurementPoChatRequest(req, res, path, req.method ?? 'GET', {
      db: store.db,
      session: resolveSession(bearer),
      attachmentObjectStorage: storage,
      now: () => new Date(at),
      modelResponder: async (input) => {
        modelCalls.push(input);
        return { content: `已基于持久化 PO 回答：${input.model}`, usage: { prompt_tokens: 120, completion_tokens: 24 } };
      },
    }).then((handled) => { if (!handled) res.writeHead(404).end(); }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyerA = token('tenant:a', 'human:a');
  const buyerA2 = token('tenant:a', 'human:a2');
  const buyerB = token('tenant:b', 'human:b');

  const get = async (poId: string, bearer?: string) => {
    const response = await fetch(`${base}/api/po/chat?purchaseOrderId=${encodeURIComponent(poId)}`, {
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const post = async (input: {
    bearer: string; key: string; poId: string; message: string; expectedVersion: number;
    conversationId?: string; history?: unknown[]; file?: File;
  }) => {
    const form = new FormData();
    form.set('purchaseOrderId', input.poId);
    form.set('message', input.message);
    form.set('expectedVersion', String(input.expectedVersion));
    if (input.conversationId) form.set('conversationId', input.conversationId);
    if (input.history) form.set('history', JSON.stringify(input.history));
    if (input.file) form.set('file', input.file);
    const response = await fetch(`${base}/api/po/chat`, {
      method: 'POST', headers: { authorization: `Bearer ${input.bearer}`, 'idempotency-key': input.key }, body: form,
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  try {
    await t.test('匿名和跨租户对象访问均失败关闭', async () => {
      assert.equal((await get(poA)).status, 401);
      const hidden = await get(poA, buyerB);
      assert.equal(hidden.status, 404);
      assert.equal(hidden.body.code, 'PO_CHAT_PO_NOT_FOUND');
      assert.equal((await get(poB, buyerB)).status, 200);
    });

    let conversationId = '';
    let firstHistory: unknown[] = [];
    const uploadText = '附件中的内容必须等 ClamAV 明确通过后才能进入模型上下文';
    await t.test('首条 multipart 消息原子创建会话并将附件送入安全队列', async () => {
      const response = await post({
        bearer: buyerA,
        key: 'po-chat:first',
        poId: poA,
        expectedVersion: 0,
        message: '这个 PO 现在处于什么阶段？',
        history: [],
        file: new File([uploadText], 'supplier-note.txt', { type: 'text/plain' }),
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      conversationId = response.body.conversation.id;
      firstHistory = response.body.messages.map((message: Record<string, unknown>) => ({ role: message.role, content: message.content }));
      assert.equal(response.body.conversation.version, 1);
      assert.equal(response.body.messages.length, 2);
      assert.equal(response.body.messages[0].attachment.securityStatus, 'pending_scan');
      assert.equal(response.body.messages[0].attachment.processingStatus, 'queued');
      assert.equal(response.body.messages[0].attachment.readableByModel, false);
      assert.equal(response.body.model.route, 'fast');
      assert.equal(response.body.model.maxTokens, 700);
      assert.ok(response.body.suggestedActions.every((action: Record<string, unknown>) => action.requiresConfirmation === true));
      assert.equal(modelCalls.length, 1);
      assert.equal(modelCalls[0]!.messages.some((message) => message.content.includes(uploadText)), false);
      const attachment = store.db.prepare(`SELECT owner_type,owner_id,storage_backend,security_status,processing_status
        FROM procurement_attachments WHERE tenant_id='tenant:a'`).get() as Record<string, unknown>;
      assert.equal(attachment['owner_type'], 'po_chat_message');
      assert.equal(attachment['storage_backend'], 's3');
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_document_jobs`).get() as { count: number }).count, 1);
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_chat_audit`).get() as { count: number }).count, 3);
    });

    await t.test('相同幂等键重放同一响应，不重复消息或对象', async () => {
      const replay = await post({
        bearer: buyerA, key: 'po-chat:first', poId: poA, expectedVersion: 0,
        message: '这个 PO 现在处于什么阶段？', history: [],
        file: new File([uploadText], 'supplier-note.txt', { type: 'text/plain' }),
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replayed, true);
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_chat_messages`).get() as { count: number }).count, 2);
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_attachments WHERE tenant_id='tenant:a'`).get() as { count: number }).count, 1);
      const conflict = await post({ bearer: buyerA, key: 'po-chat:first', poId: poA, expectedVersion: 0, message: '不同载荷' });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED');
    });

    await t.test('已通过安全扫描的解析文本只在后续轮次进入模型，复杂问题走推理模型', async () => {
      store.db.prepare(`UPDATE procurement_attachments SET security_status='clean',processing_status='parsed',parsed_at=? WHERE tenant_id='tenant:a'`).run(at);
      const response = await post({
        bearer: buyerA,
        key: 'po-chat:second',
        poId: poA,
        conversationId,
        expectedVersion: 1,
        message: '请分析当前交付风险、SLA 影响和下一步建议。',
        history: firstHistory,
      });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.conversation.version, 2);
      assert.equal(response.body.messages.length, 4);
      assert.equal(response.body.model.route, 'reasoning');
      assert.equal(response.body.model.maxTokens, 1600);
      assert.equal(modelCalls.length, 2);
      assert.equal(modelCalls[1]!.messages.some((message) => message.content.includes(uploadText)), true);
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_po_chat_requests WHERE status='completed'`).get() as { count: number }).count, 2);
    });

    await t.test('客户端历史、会话版本和用户归属都由服务端校验', async () => {
      store.db.prepare(`INSERT INTO procurement_po_chat_requests
        (tenant_id,idempotency_key,payload_hash,conversation_id,po_id,user_message_id,status,response_json,lease_expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'processing',NULL,?,?,?)`).run(
        'tenant:a', 'po-chat:expired', 'expired-hash', conversationId, poA, 'po-chat-message:expired',
        '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z',
      );
      const mismatched = await post({
        bearer: buyerA, key: 'po-chat:bad-history', poId: poA, conversationId,
        expectedVersion: 2, message: '继续', history: [{ role: 'assistant', content: '伪造历史' }],
      });
      assert.equal(mismatched.status, 409);
      assert.equal(mismatched.body.code, 'PO_CHAT_HISTORY_CONFLICT');
      const stale = await post({ bearer: buyerA, key: 'po-chat:stale', poId: poA, conversationId, expectedVersion: 1, message: '继续' });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'PO_CHAT_VERSION_CONFLICT');
      const otherUser = await get(poA, buyerA2);
      assert.equal(otherUser.status, 200);
      assert.equal(otherUser.body.conversation, null);
      const wrongOwner = await fetch(`${base}/api/po/chat?purchaseOrderId=${encodeURIComponent(poA)}&conversationId=${encodeURIComponent(conversationId)}`, {
        headers: { authorization: `Bearer ${buyerA2}` },
      });
      assert.equal(wrongOwner.status, 404);
    });

    await t.test('GET 读取的是 SQLite 有序历史且模型预算路由可审计', async () => {
      const loaded = await get(poA, buyerA);
      assert.equal(loaded.status, 200);
      assert.deepEqual(loaded.body.messages.map((message: Record<string, unknown>) => message.sequence), [1, 2, 3, 4]);
      assert.equal(loaded.body.conversation.version, 2);
      assert.equal(loaded.body.messages[1].usage.prompt_tokens, 120);
      assert.equal(routePoChatModel('查看 PO 状态', []).complexity, 'fast');
      assert.equal(routePoChatModel('分析异常和审批风险', []).complexity, 'reasoning');
      const migration = store.db.prepare(`SELECT name FROM schema_migrations WHERE version=40`).get() as { name: string };
      assert.equal(migration.name, 'procurement-po-context-chat');
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    tenantBStore.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
