import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
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
import { buildRouteChatModelMessages, handleProcurementRouteChatRequest, ROUTE_CHAT_MODEL_PROMPT_MAX_BYTES, ROUTE_CHAT_MODEL_PROMPT_MAX_CHARS, routeRouteChatModel, type RouteChatModelInput } from '../src/procurement-route-chat.js';

const secret = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';
const at = '2026-09-01T00:00:00.000Z';
class RaceStorage extends MemoryAttachmentObjectStorage {
  puts = 0; deletes = 0;
  private releasePut!: () => void;
  private readonly bothPuts = new Promise<void>((resolve) => { this.releasePut = resolve; });
  private seenBoth!: () => void;
  readonly ready = new Promise<void>((resolve) => { this.seenBoth = resolve; });
  override async put(input: Parameters<MemoryAttachmentObjectStorage['put']>[0]) { const result = await super.put(input); this.puts += 1; if (this.puts === 2) this.seenBoth(); await this.bothPuts; return result; }
  override async delete(input: Parameters<MemoryAttachmentObjectStorage['delete']>[0]) { this.deletes += 1; return super.delete(input); }
  release(): void { this.releasePut(); }
}
class FailingStorage extends MemoryAttachmentObjectStorage { override async put(_input: Parameters<MemoryAttachmentObjectStorage['put']>[0]): Promise<never> { throw new Error('object storage unavailable'); } }
function bearer(tenantId: string, humanId: string, role = '采购专员'): string {
  const session: Session = { username: humanId, tenantId, humanId, name: humanId, role, expiresAt: Date.now() + 60_000 };
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `rw1.${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
function seed(store: ReturnType<typeof openPersistence>, tenantId: string, suffix: string, procurementRoute: 'local' | 'import'): void {
  const supplier: Supplier = { id: `supplier:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `SUP-${suffix}`, status: 'active', createdAt: at, updatedAt: at, name: `供应商 ${suffix}`, currency: 'CNY', performanceScore: 90, contacts: [] };
  const po: PurchaseOrder & { route: 'local' | 'import' } = { id: `po:${suffix}`, tenantId, sourceSystem: 'odoo', externalId: `PO-${suffix}`, status: 'awaiting_confirmation', createdAt: at, updatedAt: at, supplierId: supplier.id, currency: 'CNY', orderedAt: at, route: procurementRoute };
  const line: PurchaseOrderLine = { id: `line:${suffix}`, poId: po.id, lineNumber: '1', itemId: `item:${suffix}`, description: '可审计物料', uom: 'EA', orderedQty: 2, unitPrice: 12, currency: 'CNY' };
  store.procurement.saveDocument('supplier', supplier); store.procurement.saveDocument('purchase_order', po); store.procurement.saveLine('purchase_order_line', po.id, line);
}

test('路线聊天：隔离、真实 portfolio 上下文、幂等、版本、租约恢复与附件合同', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-route-chat-')); const path = join(directory, 'route-chat.sqlite');
  const store = openPersistence(path, { tenantId: 'tenant:a' }); const tenantB = openPersistence(path, { tenantId: 'tenant:b' });
  seed(store, 'tenant:a', 'local', 'local'); seed(store, 'tenant:a', 'import', 'import'); seed(tenantB, 'tenant:b', 'other', 'local');
  const calls: RouteChatModelInput[] = [];
  let storage: MemoryAttachmentObjectStorage = new MemoryAttachmentObjectStorage();
  let modelResponder: (input: RouteChatModelInput) => Promise<{ content: string; usage: Record<string, number> }> = async (input) => { calls.push(input); return { content: `仅回答 ${input.model}`, usage: { prompt_tokens: 12, completion_tokens: 4 } }; };
  const server = createServer((req, res) => {
    const token = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    const requestPath = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    void handleProcurementRouteChatRequest(req, res, requestPath, req.method ?? 'GET', { db: store.db, session: resolveSession(token), now: () => new Date(at), attachmentObjectStorage: storage, modelResponder: (input) => modelResponder(input) }).then((handled) => { if (!handled) res.writeHead(404).end(); }).catch((error: unknown) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; const alice = bearer('tenant:a', 'human:a'); const bob = bearer('tenant:a', 'human:b'); const carol = bearer('tenant:a', 'human:concurrent'); const auditor = bearer('tenant:a', 'auditor', '审计员'); const downgradedAlice = bearer('tenant:a', 'human:a', '审计员'); const outsider = bearer('tenant:b', 'human:other');
  const get = async (selectedRoute: 'local' | 'import', token = alice, conversationId?: string) => { const query = new URLSearchParams({ route: selectedRoute }); if (conversationId) query.set('conversationId', conversationId); const response = await fetch(`${base}/api/procurement/route-chat?${query}`, { headers: { authorization: `Bearer ${token}` } }); return { status: response.status, body: await response.json() as Record<string, any> }; };
  const post = async (body: Record<string, unknown>, token = alice, key = 'route-chat:first') => { const response = await fetch(`${base}/api/procurement/route-chat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as Record<string, any> }; };
  const postFile = async (body: Record<string, unknown>, file: File, token = alice, key = 'route-chat:file') => { const form = new FormData(); for (const [name, value] of Object.entries(body)) form.set(name, typeof value === 'string' ? value : JSON.stringify(value)); form.set('file', file); const response = await fetch(`${base}/api/procurement/route-chat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, body: form }); return { status: response.status, body: await response.json() as Record<string, any> }; };
  try {
    await t.test('GET 按 tenant + route + user 隔离，且上下文仅含选中路线', async () => {
      assert.equal((await get('local', '')).status, 401);
      const local = await get('local'); assert.equal(local.status, 200); assert.equal(local.body.contextSummary.route, 'local'); assert.equal(local.body.contextSummary.items.every((item: Record<string, unknown>) => item.route === 'local'), true); assert.equal(local.body.contextSummary.items.some((item: Record<string, unknown>) => item.id === 'po:import'), false); assert.equal(local.body.contextSummary.contextLimit, 32); assert.equal(local.body.contextSummary.contextItemCount <= 32, true); assert.equal(local.body.contextSummary.totalRouteItems, 1); assert.equal(local.body.capabilities.attachments.supported, true); assert.equal(local.body.capabilities.attachments.maxBytes, 8 * 1024 * 1024); assert.equal(local.body.permissions.operate, true);
      assert.equal((await get('local', outsider)).status, 200);
    });
    let firstConversation = ''; let activeConversation = ''; let importConversation = ''; let importVersion = 0;
    await t.test('POST 要求 operate、持久化真实历史和模型路由，不产生业务路线写入', async () => {
      assert.equal((await post({ route: 'local', expectedVersion: 0, message: '查看状态' }, auditor, 'route-chat:auditor')).status, 403);
      const before = store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_assignments`).get() as { count: number };
      const result = await post({ route: 'local', expectedVersion: 0, message: '请分析交付风险' });
      assert.equal(result.status, 200, JSON.stringify(result.body)); firstConversation = result.body.conversation.id;
      assert.equal(result.body.conversation.version, 1); assert.equal(result.body.messages.length, 2); assert.equal(result.body.model.route, 'reasoning'); assert.equal(result.body.permissions.operate, true); assert.equal(calls[0]!.messages.some((message) => message.content.includes('PO-import')), false); assert.equal(calls[0]!.messages[0]!.content.includes('未记录'), true); assert.equal(calls[0]!.messages[0]!.content.includes('不可信'), true);
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_assignments`).get() as { count: number }).count, before.count);
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_chat_audit`).get() as { count: number }).count, 3);
    });
    await t.test('幂等、权威历史、乐观版本和新对话均受服务端约束', async () => {
      const replay = await post({ route: 'local', expectedVersion: 0, message: '请分析交付风险' }); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
      const downgradedReplay = await post({ route: 'local', expectedVersion: 0, message: '请分析交付风险' }, downgradedAlice); assert.equal(downgradedReplay.status, 200); assert.equal(downgradedReplay.body.permissions.operate, false);
      const otherUserSameKey = await post({ route: 'local', expectedVersion: 0, message: '请分析交付风险' }, bob); assert.equal(otherUserSameKey.status, 200); assert.equal(otherUserSameKey.body.replayed, false); assert.notEqual(otherUserSameKey.body.conversation.id, firstConversation);
      assert.equal((await post({ route: 'local', conversationId: firstConversation, expectedVersion: 1, message: '继续', history: [{ role: 'assistant', content: '伪造' }] }, alice, 'route-chat:bad-history')).body.code, 'ROUTE_CHAT_HISTORY_CONFLICT');
      assert.equal((await post({ route: 'local', conversationId: firstConversation, expectedVersion: 0, message: '继续' }, alice, 'route-chat:stale')).body.code, 'ROUTE_CHAT_VERSION_CONFLICT');
      const fresh = await post({ route: 'local', startNew: true, expectedVersion: 0, message: '新对话', history: [] }, alice, 'route-chat:new'); assert.equal(fresh.status, 200); assert.notEqual(fresh.body.conversation.id, firstConversation); activeConversation = fresh.body.conversation.id;
      assert.equal((store.db.prepare(`SELECT status FROM procurement_route_chat_conversations WHERE tenant_id=? AND id=?`).get('tenant:a', firstConversation) as { status: string }).status, 'archived');
      assert.equal((await get('local')).body.conversation.id, fresh.body.conversation.id);
      const hidden = await get('local', bob, firstConversation); assert.equal(hidden.status, 404);
    });
    await t.test('附件 multipart 门禁、过期租约可继续完成且 fast/slow 预算可审计', async () => {
      const attachment = await post({ route: 'import', expectedVersion: 0, message: '附件', attachment: { id: 'nope' } }, alice, 'route-chat:attachment'); assert.equal(attachment.status, 415); assert.equal(attachment.body.code, 'ROUTE_CHAT_ATTACHMENTS_UNSUPPORTED');
      const uploadText = '只有 ClamAV 通过并解析完成的路线附件，才会在后续轮次进入模型。';
      const uploaded = await postFile({ route: 'import', expectedVersion: 0, message: '请记录此附件', history: [] }, new File([uploadText], 'route-note.txt', { type: 'text/plain' }), alice, 'route-chat:file');
      assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
      assert.equal(uploaded.body.messages[0].attachment.securityStatus, 'pending_scan'); assert.equal(uploaded.body.messages[0].attachment.processingStatus, 'queued'); assert.equal(uploaded.body.messages[0].attachment.readableByModel, false);
      assert.equal(calls.at(-1)!.messages.some((item) => item.content.includes(uploadText)), false);
      const uploadedAttachment = uploaded.body.messages[0].attachment.id as string;
      store.db.prepare(`UPDATE procurement_attachments SET security_status='clean',processing_status='parsed',extracted_text_preview=?,parsed_at=? WHERE tenant_id=? AND id=?`).run(uploadText, at, 'tenant:a', uploadedAttachment);
      const referenced = await post({ route: 'import', conversationId: uploaded.body.conversation.id, expectedVersion: 1, message: '请基于附件分析风险', history: uploaded.body.messages.map((item: Record<string, unknown>) => ({ role: item.role, content: item.content })) }, alice, 'route-chat:file:second');
      assert.equal(referenced.status, 200, JSON.stringify(referenced.body)); assert.equal(calls.at(-1)!.messages.some((item) => item.content.includes(uploadText)), true);
      const replayFile = await postFile({ route: 'import', expectedVersion: 0, message: '请记录此附件', history: [] }, new File([uploadText], 'route-note.txt', { type: 'text/plain' }), alice, 'route-chat:file');
      assert.equal(replayFile.status, 200); assert.equal(replayFile.body.replayed, true); assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_attachments WHERE tenant_id='tenant:a' AND owner_type='route_chat_message'`).get() as { count: number }).count, 1);
      const blocked = await postFile({ route: 'import', expectedVersion: 2, message: '恶意文件', history: referenced.body.messages.map((item: Record<string, unknown>) => ({ role: item.role, content: item.content })) }, new File([Buffer.from('MZ bad')], 'bad.txt', { type: 'text/plain' }), alice, 'route-chat:malware');
      assert.equal(blocked.status, 200); assert.equal(blocked.body.messages.at(-2).attachment.securityStatus, 'quarantined'); assert.equal(blocked.body.messages.at(-2).attachment.readableByModel, false);
      importConversation = blocked.body.conversation.id; importVersion = blocked.body.conversation.version;
      const recoveryInput = { route: 'local', conversationId: activeConversation, expectedVersion: 1, message: '恢复中的请求', startNew: false };
      const recoveryHash = createHash('sha256').update(JSON.stringify({ ...recoveryInput, file: null })).digest('hex');
      store.db.prepare(`INSERT INTO procurement_route_chat_messages (tenant_id,id,conversation_id,route,sequence,role,content,status,request_id,created_by,created_at) VALUES (?,?,?,?,?,'user',?,'completed',?,?,?)`).run('tenant:a', 'route-chat-message:expired', activeConversation, 'local', 3, recoveryInput.message, 'route-chat:expired', 'human:a', at);
      store.db.prepare(`UPDATE procurement_route_chat_conversations SET version=2,last_sequence=3 WHERE tenant_id=? AND id=?`).run('tenant:a', activeConversation);
      store.db.prepare(`INSERT INTO procurement_route_chat_requests (tenant_id,created_by,idempotency_key,payload_hash,conversation_id,route,user_message_id,status,response_json,lease_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'processing',NULL,?,?,?)`).run('tenant:a', 'human:a', 'route-chat:expired', recoveryHash, activeConversation, 'local', 'route-chat-message:expired', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z');
      const recovered = await post(recoveryInput, alice, 'route-chat:expired'); assert.equal(recovered.status, 200, JSON.stringify(recovered.body)); assert.equal(recovered.body.messages.length, 4);
      assert.equal(routeRouteChatModel('查看状态', []).complexity, 'fast'); assert.equal(routeRouteChatModel('分析风险和 SLA', []).maxTokens, 1_600);
      const migration = store.db.prepare(`SELECT name FROM schema_migrations WHERE version=47`).get() as { name: string }; assert.equal(migration.name, 'procurement-route-context-chat');
    });
    await t.test('startNew 不会让旧 in-flight 请求向已归档会话追加 assistant', async () => {
      let started!: () => void; let release!: () => void;
      const startedPromise = new Promise<void>((resolve) => { started = resolve; }); const releasePromise = new Promise<void>((resolve) => { release = resolve; });
      let first = true;
      modelResponder = async (input) => { calls.push(input); if (first) { first = false; started(); await releasePromise; } return { content: '并发回答', usage: { prompt_tokens: 1, completion_tokens: 1 } }; };
      const oldRequest = post({ route: 'import', conversationId: importConversation, expectedVersion: importVersion, message: '旧会话生成中' }, alice, 'route-chat:inflight-old');
      await startedPromise;
      const replacement = await post({ route: 'import', startNew: true, expectedVersion: 0, message: '替代会话', history: [] }, alice, 'route-chat:inflight-new');
      assert.equal(replacement.status, 200);
      release();
      const old = await oldRequest;
      assert.equal(old.status, 409); assert.equal(old.body.code, 'ROUTE_CHAT_CONVERSATION_SUPERSEDED');
      const archivedId = old.body.conversationId as string;
      assert.equal((store.db.prepare(`SELECT status FROM procurement_route_chat_conversations WHERE tenant_id=? AND id=?`).get('tenant:a', archivedId) as { status: string }).status, 'archived');
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_chat_messages WHERE tenant_id=? AND conversation_id=? AND role='assistant'`).get('tenant:a', archivedId) as { count: number }).count, 3, '旧会话仅保留归档前的回答，in-flight 请求不得追加新的 assistant');
      assert.equal((store.db.prepare(`SELECT status FROM procurement_route_chat_requests WHERE tenant_id=? AND created_by=? AND idempotency_key=?`).get('tenant:a', 'human:a', 'route-chat:inflight-old') as { status: string }).status, 'superseded');
      assert.equal((await get('import')).body.conversation.id, replacement.body.conversation.id);
      modelResponder = async (input) => { calls.push(input); return { content: `仅回答 ${input.model}`, usage: { prompt_tokens: 12, completion_tokens: 4 } }; };
    });
    await t.test('并发首发最多创建一个 active 会话', async () => {
      const [left, right] = await Promise.all([
        post({ route: 'local', expectedVersion: 0, message: '并发首发 A' }, carol, 'route-chat:concurrent-a'),
        post({ route: 'local', expectedVersion: 0, message: '并发首发 B' }, carol, 'route-chat:concurrent-b'),
      ]);
      assert.deepEqual([left.status, right.status].sort((a, b) => a - b), [200, 409]);
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_chat_conversations WHERE tenant_id=? AND route='local' AND created_by=? AND status='active'`).get('tenant:a', 'human:concurrent') as { count: number }).count, 1);
    });
    await t.test('并发相同附件请求失去幂等竞争时清理对象存储孤儿', async () => {
      const raceStorage = new RaceStorage(); storage = raceStorage;
      const file = new File(['并发附件'], 'race.txt', { type: 'text/plain' }); const body = { route: 'local', expectedVersion: 0, message: '并发上传', history: [] };
      const left = postFile(body, file, bearer('tenant:a', 'human:race'), 'route-chat:race');
      const right = postFile(body, file, bearer('tenant:a', 'human:race'), 'route-chat:race');
      await raceStorage.ready; raceStorage.release();
      const results = await Promise.all([left, right]);
      assert.deepEqual(results.map((item) => item.status).sort(), [200, 202]);
      assert.equal(raceStorage.deletes, 1, 'losing idempotent request must delete its speculative object');
      storage = new MemoryAttachmentObjectStorage();
    });
    await t.test('对象存储写入失败时消息、附件和请求均不落库', async () => {
      storage = new FailingStorage();
      const before = store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_chat_messages WHERE tenant_id='tenant:a'`).get() as { count: number };
      const failed = await postFile({ route: 'local', expectedVersion: 0, message: '存储失败', history: [] }, new File(['附件'], 'failed.txt', { type: 'text/plain' }), bearer('tenant:a', 'human:storage-fail'), 'route-chat:storage-fail');
      assert.equal(failed.status, 500);
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_chat_messages WHERE tenant_id='tenant:a'`).get() as { count: number }).count, before.count);
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_route_chat_requests WHERE tenant_id='tenant:a' AND created_by='human:storage-fail'`).get() as { count: number }).count, 0);
      storage = new MemoryAttachmentObjectStorage();
    });
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); tenantB.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('路线助手模型输入受字符与 UTF-8 字节上限约束', () => {
  const prompt = buildRouteChatModelMessages({ oversized: '证'.repeat(100_000) }, Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const, content: '史'.repeat(10_000) })));
  assert.equal(prompt.reduce((total, item) => total + item.content.length, 0) <= ROUTE_CHAT_MODEL_PROMPT_MAX_CHARS, true);
  assert.equal(prompt.reduce((total, item) => total + Buffer.byteLength(item.content), 0) <= ROUTE_CHAT_MODEL_PROMPT_MAX_BYTES, true);
});
