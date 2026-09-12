import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { Communication, ProcurementOutboxMessage, PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { can, type Session } from './auth.js';
import { refreshSlaEvaluations, type SlaMessageCategory } from './procurement-sla.js';
import { communicationSignature, getProcurementCommunicationIdentity, type ProcurementCommunicationIdentity } from './procurement-communication-identity.js';

export interface ProcurementMessageDraftContext {
  readonly db: DatabaseSync;
  readonly session: Session | null;
  readonly connectorReady?: (connectorId: string) => boolean;
}

export interface UpdateMessageDraftInput {
  expectedVersion: number;
  recipient: string;
  subject: string;
  body: string;
  reason: string;
}

type DraftStatus = 'draft' | 'approved_queued' | 'sent' | 'discarded';
interface DraftRow {
  tenant_id: string; id: string; purchase_order_id: string; supplier_id: string; channel: 'email' | 'whatsapp'; recipient: string;
  subject: string; body: string; category: string; trigger_code: string; trigger_evidence_json: string;
  sender_name: string | null; sender_title: string | null; sender_organization: string | null;
  status: DraftStatus; version: number; outbox_id: string | null; created_by: string; reviewed_by: string | null;
  created_at: string; updated_at: string; reviewed_at: string | null; sent_at: string | null;
}
interface JsonDocumentRow { id: string; version: number; json: string }
interface SlaDraftCandidateRow extends JsonDocumentRow {
  policy_id: string; policy_version: number; rule_id: string; evaluation_status: string; evaluation_version: number;
  due_at: string | null; grace_until: string | null; next_followup_at: string | null; followup_count: number;
  evidence_json: string; fingerprint: string;
}

type SupplierReplyField = 'quantity' | 'unit_price' | 'promised_date';

interface DraftDecisionContext {
  source: 'supplier_reply' | 'sla_policy' | 'purchase_order';
  label: string;
  summary: string;
  ruleId: string | null;
  dueAt: string | null;
  missingFields: SupplierReplyField[];
  sourceCommunication: {
    id: string;
    from: string | null;
    subject: string | null;
    receivedAt: string;
    messageId: string | null;
    body: string;
  } | null;
}

export interface QueueApprovedMessageDraftInput {
  tenantId: string;
  draftId: string;
  expectedVersion: number;
  actorId: string;
  correlationId: string;
  /** Optional exact credential selected by a guarded automation decision. */
  credentialId?: string;
  connectorReady?: (connectorId: string) => boolean;
  /** Runs inside the same transaction after the durable queue transition. */
  onQueuedInTransaction?: (result: { draft: DraftRow; outbox: ProcurementOutboxMessage }) => void;
  now?: Date;
}

export interface QueueApprovedMessageDraftResult {
  draft: DraftRow;
  outbox: ProcurementOutboxMessage;
  replayed: boolean;
}

/**
 * The sole transition from an approved message draft to the Procurement
 * Outbox. Both a human reviewer and guarded automation use this exact
 * idempotent path; it never delivers to a connector itself.
 */
export function queueApprovedMessageDraft(db: DatabaseSync, input: QueueApprovedMessageDraftInput): QueueApprovedMessageDraftResult {
  const now = (input.now ?? new Date()).toISOString();
  const outboxKey = `message_draft.approve:${input.correlationId}`;
  let outbox: ProcurementOutboxMessage;
  let replayed = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = getDraft(db, input.tenantId, input.draftId);
    if (!current) throw new DraftNotFoundError();
    if (!hasSenderIdentity(current)) throw new DraftIdentityMissingError();
    const existing = db.prepare(`SELECT json FROM procurement_outbox WHERE tenant_id=? AND channel=? AND idempotency_key=?`).get(input.tenantId, current.channel, outboxKey) as { json: string } | undefined;
    if (existing) {
      outbox = JSON.parse(existing.json) as ProcurementOutboxMessage;
      if (outbox.payload['draftId'] !== input.draftId) throw new DraftConflictError('幂等键已用于其他邮件草稿');
      replayed = true;
      db.exec('COMMIT');
    } else {
      if (current.status !== 'draft') throw new DraftConflictError('该草稿已经审批、发送或丢弃');
      if (current.version !== input.expectedVersion) throw new DraftVersionError(current.version);
      const connectorId = current.channel;
      const ready = input.connectorReady?.(connectorId) === true;
      outbox = {
        id: `procurement-outbox:${randomUUID()}`,
        tenantId: input.tenantId,
        channel: current.channel, connectorId, action: current.channel === 'email' ? 'purchase_order.draft_email.send' : 'purchase_order.draft_whatsapp.send',
        aggregateId: current.purchase_order_id, idempotencyKey: outboxKey,
        status: ready ? 'pending' : 'blocked', payload: { draftId: current.id, ...(input.credentialId ? { credentialId: input.credentialId } : {}) }, attempts: 0,
        createdAt: now, updatedAt: now,
        ...(!ready ? { error: `${connectorId} connector is not configured` } : {}),
      };
      db.prepare(`INSERT INTO procurement_outbox
        (tenant_id,id,channel,connector_id,action,aggregate_id,idempotency_key,status,payload_json,json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(input.tenantId, outbox.id, outbox.channel, outbox.connectorId, outbox.action, outbox.aggregateId,
          outbox.idempotencyKey, outbox.status, JSON.stringify(outbox.payload), JSON.stringify(outbox), now, now);
      db.prepare(`UPDATE procurement_message_drafts SET status='approved_queued',version=version+1,outbox_id=?,reviewed_by=?,reviewed_at=?,updated_at=?
        WHERE tenant_id=? AND id=? AND version=? AND status='draft'`)
        .run(outbox.id, input.actorId, now, now, input.tenantId, input.draftId, input.expectedVersion);
      insertEvent(db, input.tenantId, input.draftId, input.actorId, 'approved_and_queued', { outboxId: outbox.id, outboxStatus: outbox.status }, now);
      const queuedDraft = getDraft(db, input.tenantId, input.draftId)!;
      input.onQueuedInTransaction?.({ draft: queuedDraft, outbox });
      db.exec('COMMIT');
    }
  } catch (error) { try { db.exec('ROLLBACK'); } catch { /* transaction already committed */ } throw error; }
  return { draft: getDraft(db, input.tenantId, input.draftId)!, outbox: outbox!, replayed };
}

export async function handleProcurementMessageDraftRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: ProcurementMessageDraftContext,
): Promise<boolean> {
  const root = path === '/api/procurement/message-drafts';
  const refresh = path === '/api/procurement/message-drafts/refresh';
  const approve = path.match(/^\/api\/procurement\/message-drafts\/([^/]+)\/approve$/);
  const discard = path.match(/^\/api\/procurement\/message-drafts\/([^/]+)\/discard$/);
  const detail = path.match(/^\/api\/procurement\/message-drafts\/([^/]+)$/);
  if (!root && !refresh && !approve && !discard && !detail) return false;
  if (!context.session) { sendJson(res, 401, { error: '未登录或会话已过期', code: 'UNAUTHORIZED' }); return true; }
  const { session, db } = context;
  const capabilities = {
    edit: can(session, 'operate'),
    discard: can(session, 'operate'),
    approve: can(session, 'approve'),
  };

  if (root && method === 'GET') {
    if (!can(session, 'read')) return forbidden(res, '无读取权限');
    const status = queryStatus(req);
    const rows = status === 'all'
      ? db.prepare(`SELECT * FROM procurement_message_drafts WHERE tenant_id=? ORDER BY updated_at DESC,id DESC LIMIT 100`).all(session.tenantId)
      : db.prepare(`SELECT * FROM procurement_message_drafts WHERE tenant_id=? AND status=? ORDER BY updated_at DESC,id DESC LIMIT 100`).all(session.tenantId, status);
    const items = (rows as unknown as DraftRow[]).map((row) => presentDraft(db, session.tenantId, row));
    const counts = db.prepare(`SELECT status,COUNT(*) AS count FROM procurement_message_drafts WHERE tenant_id=? GROUP BY status`).all(session.tenantId) as Array<{ status: string; count: number }>;
    const publishedPolicy = db.prepare(`SELECT id,version FROM procurement_sla_policies WHERE tenant_id=? AND status='published' ORDER BY published_at DESC,id LIMIT 1`)
      .get(session.tenantId) as { id: string; version: number } | undefined;
    const communicationIdentity = getActiveCommunicationIdentity(db, session.tenantId);
    sendJson(res, 200, {
      items,
      counts: Object.fromEntries(counts.map((item) => [item.status, Number(item.count)])),
      generationReadiness: {
        status: !publishedPolicy ? 'sla_policy_missing' : !communicationIdentity ? 'communication_identity_missing' : 'ready',
        publishedPolicyId: publishedPolicy?.id ?? null,
        publishedPolicyVersion: publishedPolicy?.version ?? null,
        communicationIdentityVersion: communicationIdentity?.version ?? null,
      },
      capabilities,
    });
    return true;
  }

  if (refresh && method === 'POST') {
    if (!can(session, 'operate')) return forbidden(res, '无运行 SLA 检查权限');
    const published = db.prepare(`SELECT 1 AS ok FROM procurement_sla_policies WHERE tenant_id=? AND status='published'`).get(session.tenantId);
    if (!published) { sendJson(res, 409, { error: '尚未发布 SLA 策略，不能生成供应商沟通草稿', code: 'SLA_POLICY_NOT_PUBLISHED' }); return true; }
    if (!getActiveCommunicationIdentity(db, session.tenantId)) {
      sendJson(res, 409, { error: '尚未配置供应商可见的采购专业联系人，不能生成外部沟通草稿', code: 'COMMUNICATION_IDENTITY_MISSING' });
      return true;
    }
    const result = refreshSlaDrafts(db, session.tenantId, session.humanId, new Date());
    sendJson(res, 200, result);
    return true;
  }

  if (detail && method === 'GET') {
    if (!can(session, 'read')) return forbidden(res, '无读取权限');
    const row = getDraft(db, session.tenantId, decodeURIComponent(detail[1]!));
    if (!row) { sendJson(res, 404, { error: '邮件草稿不存在', code: 'MESSAGE_DRAFT_NOT_FOUND' }); return true; }
    sendJson(res, 200, { item: presentDraft(db, session.tenantId, row), events: listEvents(db, session.tenantId, row.id), capabilities });
    return true;
  }

  if (detail && method === 'PATCH') {
    if (!can(session, 'operate')) return forbidden(res, '无编辑权限');
    try {
      const body = await readJsonBody(req);
      const allowed = new Set(['expectedVersion', 'recipient', 'subject', 'body', 'reason']);
      for (const key of Object.keys(body)) if (!allowed.has(key)) throw new DraftInputError(`不允许的字段: ${key}`);
      const expectedVersion = positiveInteger(body['expectedVersion'], 'expectedVersion');
      const recipientInput = requiredText(body['recipient'], 'recipient', 500);
      const subject = requiredText(body['subject'], 'subject', 500);
      const messageBody = requiredText(body['body'], 'body', 20_000);
      const reason = requiredText(body['reason'], 'reason', 500);
      const id = decodeURIComponent(detail[1]!);
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = getDraft(db, session.tenantId, id);
        if (!current) throw new DraftNotFoundError();
        const recipient = normalizeDraftRecipient(current.channel, recipientInput);
        if (current.status !== 'draft') throw new DraftConflictError('只有待审核草稿可编辑');
        if (current.version !== expectedVersion) throw new DraftVersionError(current.version);
        db.prepare(`UPDATE procurement_message_drafts SET recipient=?,subject=?,body=?,version=version+1,updated_at=? WHERE tenant_id=? AND id=? AND version=? AND status='draft'`)
          .run(recipient, subject, messageBody, now, session.tenantId, id, expectedVersion);
        insertEvent(db, session.tenantId, id, session.humanId, 'edited', {
          previousVersion: expectedVersion,
          channel: current.channel,
          purchaseOrderId: current.purchase_order_id,
          reason,
          previousRecipientMasked: maskDraftRecipient(current.channel, normalizeDraftRecipient(current.channel, current.recipient)),
          previousRecipientSha256: hashDraftRecipient(normalizeDraftRecipient(current.channel, current.recipient)),
          recipientMasked: maskDraftRecipient(current.channel, recipient),
          recipientSha256: hashDraftRecipient(recipient),
          previousSubjectSha256: hashDraftRecipient(current.subject),
          subjectSha256: hashDraftRecipient(subject),
          previousBodySha256: hashDraftRecipient(current.body),
          bodySha256: hashDraftRecipient(messageBody),
        }, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const updated = getDraft(db, session.tenantId, id)!;
      sendJson(res, 200, { item: presentDraft(db, session.tenantId, updated), events: listEvents(db, session.tenantId, id) });
    } catch (error) { sendDraftError(res, error); }
    return true;
  }

  if (approve && method === 'POST') {
    if (!can(session, 'approve')) return forbidden(res, '当前角色无邮件审批权限');
    try {
      const body = await readJsonBody(req);
      const allowed = new Set(['expectedVersion']);
      for (const key of Object.keys(body)) if (!allowed.has(key)) throw new DraftInputError(`不允许的字段: ${key}`);
      const expectedVersion = positiveInteger(body['expectedVersion'], 'expectedVersion');
      const requestKey = idempotencyKey(req);
      const id = decodeURIComponent(approve[1]!);
      const queued = queueApprovedMessageDraft(db, {
        tenantId: session.tenantId, draftId: id, expectedVersion, actorId: session.humanId, correlationId: requestKey,
        connectorReady: context.connectorReady,
      });
      sendJson(res, queued.replayed ? 200 : 201, { item: presentDraft(db, session.tenantId, queued.draft), outbox: queued.outbox, replayed: queued.replayed });
    } catch (error) { sendDraftError(res, error); }
    return true;
  }

  if (discard && method === 'POST') {
    if (!can(session, 'operate')) return forbidden(res, '无丢弃草稿权限');
    try {
      const body = await readJsonBody(req);
      const allowed = new Set(['expectedVersion', 'reason']);
      for (const key of Object.keys(body)) if (!allowed.has(key)) throw new DraftInputError(`不允许的字段: ${key}`);
      const expectedVersion = positiveInteger(body['expectedVersion'], 'expectedVersion');
      const reason = body['reason'] === undefined ? '人工丢弃' : requiredText(body['reason'], 'reason', 500);
      const id = decodeURIComponent(discard[1]!);
      const now = new Date().toISOString();
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = getDraft(db, session.tenantId, id);
        if (!current) throw new DraftNotFoundError();
        if (current.status !== 'draft') throw new DraftConflictError('只有待审核草稿可丢弃');
        if (current.version !== expectedVersion) throw new DraftVersionError(current.version);
        db.prepare(`UPDATE procurement_message_drafts SET status='discarded',version=version+1,reviewed_by=?,reviewed_at=?,updated_at=? WHERE tenant_id=? AND id=? AND version=? AND status='draft'`)
          .run(session.humanId, now, now, session.tenantId, id, expectedVersion);
        insertEvent(db, session.tenantId, id, session.humanId, 'discarded', { reason }, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      const updated = getDraft(db, session.tenantId, id)!;
      sendJson(res, 200, { item: presentDraft(db, session.tenantId, updated), events: listEvents(db, session.tenantId, id) });
    } catch (error) { sendDraftError(res, error); }
    return true;
  }

  sendJson(res, 405, { error: '不支持的方法', code: 'METHOD_NOT_ALLOWED' });
  return true;
}

export function refreshSlaDrafts(db: DatabaseSync, tenantId: string, actorId: string, now: Date): { created: number; examined: number; skippedWithoutRecipient: number } {
  const communicationIdentity = getActiveCommunicationIdentity(db, tenantId);
  if (!communicationIdentity) throw new DraftIdentityMissingError();
  const refresh = refreshSlaEvaluations(db, tenantId, actorId, now);
  const rows = db.prepare(`SELECT d.id,d.version,d.json,e.policy_id,e.policy_version,e.rule_id,e.status AS evaluation_status,
      e.version AS evaluation_version,e.due_at,e.grace_until,e.next_followup_at,e.followup_count,e.evidence_json,e.fingerprint
    FROM procurement_sla_evaluations e JOIN procurement_documents d
      ON d.tenant_id=e.tenant_id AND d.id=e.po_id AND d.kind='purchase_order'
    WHERE e.tenant_id=? AND e.status IN ('breached','escalated') AND e.rule_id IS NOT NULL
    ORDER BY e.due_at,d.updated_at DESC`).all(tenantId) as unknown as SlaDraftCandidateRow[];
  let created = 0; let skippedWithoutRecipient = 0;
  const nowIso = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const po = JSON.parse(row.json) as PurchaseOrder & { number?: string; promisedAt?: string; amountTotal?: number };
      if (row.next_followup_at && Date.parse(row.next_followup_at) > now.getTime()) continue;
      const evaluationEvidence = safeJson(row.evidence_json) as Record<string, unknown>;
      const category = evaluationEvidence['messageCategory'];
      if (typeof category !== 'string' || !isMessageCategory(category)) continue;
      const channel = evaluationEvidence['communicationChannel'] === 'whatsapp' ? 'whatsapp' as const : 'email' as const;
      const decision = { category, channel, evidence: evaluationEvidence };
      const supplierRow = db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?`).get(tenantId, po.supplierId) as { json: string } | undefined;
      const supplier = supplierRow ? JSON.parse(supplierRow.json) as Supplier : undefined;
      const contact = channel === 'whatsapp'
        ? supplier?.contacts.find((item) => item.primary && item.phone) ?? supplier?.contacts.find((item) => item.phone)
        : supplier?.contacts.find((item) => item.primary && item.email) ?? supplier?.contacts.find((item) => item.email);
      const recipientInput = channel === 'whatsapp' ? contact?.phone : contact?.email;
      if (!recipientInput || (channel === 'email' ? isPlaceholderRecipient(recipientInput) : !isValidWhatsAppRecipient(recipientInput))) { skippedWithoutRecipient += 1; continue; }
      const recipient = normalizeDraftRecipient(channel, recipientInput);
      const triggerCode = `sla:${row.policy_id}:${row.rule_id}:${po.id}:${row.fingerprint}`;
      const existing = db.prepare(`SELECT 1 AS ok FROM procurement_message_drafts WHERE tenant_id=? AND trigger_code=?`).get(tenantId, triggerCode);
      if (existing) continue;
      const lines = db.prepare(`SELECT json FROM procurement_lines WHERE tenant_id=? AND kind='purchase_order_line' AND document_id=? ORDER BY line_number LIMIT 5`).all(tenantId, po.id) as Array<{ json: string }>;
      const parsedLines = lines.map((item) => JSON.parse(item.json) as PurchaseOrderLine & { itemName?: string });
      const number = po.number ?? po.externalId ?? po.id;
      const itemSummary = parsedLines.map((line) => line.itemName ?? line.description ?? line.itemId).filter(Boolean).slice(0, 3).join('、') || '采购订单物料';
      const subject = decision.category === 'acknowledgement_followup'
        ? `请确认采购订单 ${number} | ${itemSummary}`
        : `紧急：请更新采购订单 ${number} 交付进度`;
      const body = buildDraftBody({ po, number, supplierName: supplier?.name ?? po.supplierId, contactName: contact?.name ?? '', itemSummary, lines: parsedLines, decision, communicationIdentity });
      const id = `message-draft:${randomUUID()}`;
      const evidence = {
        ...decision.evidence,
        slaPolicyId: row.policy_id,
        slaPolicyVersion: row.policy_version,
        slaRuleId: row.rule_id,
        slaEvaluationVersion: row.evaluation_version,
        slaEvaluationStatus: row.evaluation_status,
        slaEvaluationFingerprint: row.fingerprint,
        dueAt: row.due_at,
        graceUntil: row.grace_until,
        nextFollowupAt: row.next_followup_at,
        followupCount: row.followup_count,
        poVersion: row.version,
        purchaseOrderId: po.id,
        generatedAt: nowIso,
        communicationIdentity: {
          displayName: communicationIdentity.displayName,
          title: communicationIdentity.title,
          organizationName: communicationIdentity.organizationName,
          version: communicationIdentity.version,
        },
      };
      db.prepare(`INSERT INTO procurement_message_drafts
        (tenant_id,id,purchase_order_id,supplier_id,channel,recipient,subject,body,category,trigger_code,trigger_evidence_json,status,version,created_by,created_at,updated_at,sender_name,sender_title,sender_organization)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(tenantId, id, po.id, po.supplierId, channel, recipient, subject, body, decision.category, triggerCode, JSON.stringify({ ...evidence, communicationChannel: channel }), 'draft', 1, 'ai:procurement-sla', nowIso, nowIso,
          communicationIdentity.displayName, communicationIdentity.title, communicationIdentity.organizationName);
      insertEvent(db, tenantId, id, actorId, 'generated_by_sla', evidence, nowIso);
      created += 1;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { created, examined: refresh.evaluated, skippedWithoutRecipient };
}

function buildDraftBody(input: { po: PurchaseOrder & { promisedAt?: string }; number: string; supplierName: string; contactName: string; itemSummary: string; lines: readonly PurchaseOrderLine[]; decision: { category: string; channel: 'email' | 'whatsapp'; evidence: Record<string, unknown> }; communicationIdentity: ProcurementCommunicationIdentity }): string {
  const salutation = `${input.contactName || input.supplierName}，您好：`;
  const signature = communicationSignature(input.communicationIdentity);
  if (input.decision.category === 'acknowledgement_followup') {
    return `${salutation}\n\n我们尚未收到采购订单 ${input.number} 的正式确认，该订单涉及：${input.itemSummary}。\n\n请回复确认：\n1. 已收到并接受该采购订单；\n2. 各行物料、数量、单价（含币种）与承诺交期（含年份）；\n3. 已知的供应或发运风险。\n\n请直接用普通文字回复，无需填写代码或固定格式。如有差异，请说明变更内容。\n\n如需我方补充信息，请直接回复本${input.decision.channel === 'whatsapp' ? ' WhatsApp 消息' : '邮件'}。\n\n${signature}`;
  }
  const due = input.po.promisedAt ? new Date(input.po.promisedAt).toLocaleDateString('zh-CN') : '尚未确认';
  return `${salutation}\n\n采购订单 ${input.number} 的要求到货日为 ${due}，当前已进入交付风险检查窗口。订单物料：${input.itemSummary}。\n\n请在回复中提供：\n1. 已完成数量和剩余生产计划；\n2. 预计发货日、运输方式和追踪号（如已生成）；\n3. 任何可能影响到货的风险以及恢复方案。\n\n请尽快回复，便于我们更新采购计划。\n\n${signature}`;
}

export function normalizeDraftRecipient(channel: 'email' | 'whatsapp', value: string): string {
  if (typeof value !== 'string') throw new DraftInputError('收件人必填');
  const trimmed = value.trim();
  if (channel === 'whatsapp') {
    if (!trimmed.startsWith('+') || /[^+\d\s().-]/.test(trimmed) || trimmed.slice(1).includes('+')) {
      throw new DraftInputError('WhatsApp 收件人必须是 E.164 号码');
    }
    const normalized = `+${trimmed.slice(1).replace(/[\s().-]/g, '')}`;
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new DraftInputError('WhatsApp 收件人必须是 E.164 号码');
    return normalized;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized.length > 254) throw new DraftInputError('邮件收件人无效');
  const parts = normalized.split('@');
  if (parts.length !== 2) throw new DraftInputError('邮件收件人无效');
  const [local = '', domain = ''] = parts;
  const atom = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
  const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!local || local.length > 64 || !atom.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    throw new DraftInputError('邮件收件人无效');
  }
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => !domainLabel.test(label))) throw new DraftInputError('邮件收件人无效');
  const placeholder = domain === 'example.com'
    || domain.endsWith('.example.com')
    || domain === 'example.org'
    || domain.endsWith('.example.org')
    || domain === 'example.net'
    || domain.endsWith('.example.net')
    || domain === 'demo.cn'
    || domain.endsWith('.demo.cn')
    || domain.endsWith('.invalid')
    || domain.endsWith('.local')
    || domain.endsWith('.test');
  if (placeholder) throw new DraftInputError('邮件收件人不能使用占位或本地域名');
  return normalized;
}

export function maskDraftRecipient(channel: 'email' | 'whatsapp', normalized: string): string {
  if (channel === 'email') {
    const at = normalized.indexOf('@');
    return `${normalized.slice(0, 1)}***${normalized.slice(at)}`;
  }
  const visiblePrefixLength = Math.min(3, Math.max(1, normalized.length - 4));
  return `${normalized.slice(0, visiblePrefixLength)}${'*'.repeat(normalized.length - visiblePrefixLength - 4)}${normalized.slice(-4)}`;
}

export function hashDraftRecipient(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

function isPlaceholderRecipient(email: string): boolean {
  try { normalizeDraftRecipient('email', email); return false; } catch { return true; }
}

function isValidWhatsAppRecipient(phone: string): boolean {
  try { normalizeDraftRecipient('whatsapp', phone); return true; } catch { return false; }
}

function isMessageCategory(value: string): value is SlaMessageCategory {
  return ['acknowledgement_followup', 'production_progress_followup', 'dispatch_followup', 'delivery_status_escalation', 'grn_followup'].includes(value);
}

function presentDraft(db: DatabaseSync, tenantId: string, row: DraftRow): Record<string, unknown> {
  const poRow = db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(tenantId, row.purchase_order_id) as { json: string } | undefined;
  const supplierRow = db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='supplier' AND id=?`).get(tenantId, row.supplier_id) as { json: string } | undefined;
  const po = poRow ? JSON.parse(poRow.json) as PurchaseOrder & { number?: string; amountTotal?: number; promisedAt?: string } : undefined;
  const supplier = supplierRow ? JSON.parse(supplierRow.json) as Supplier : undefined;
  const outbox = row.outbox_id ? db.prepare(`SELECT status,attempt,dispatched_at,failed_at,updated_at,json FROM procurement_outbox WHERE tenant_id=? AND id=?`).get(tenantId, row.outbox_id) as { status: string; attempt: number; dispatched_at: string | null; failed_at: string | null; updated_at: string; json: string } | undefined : undefined;
  const outboxJson = outbox ? safeJson(outbox.json) as Record<string, unknown> : undefined;
  const whatsappDelivery = row.channel === 'whatsapp' ? db.prepare(`SELECT provider_message_id,status,occurred_at,error_code,error_message
    FROM procurement_whatsapp_delivery_events WHERE tenant_id=? AND draft_id=?
    ORDER BY CASE status WHEN 'read' THEN 5 WHEN 'delivered' THEN 4 WHEN 'sent' THEN 3 WHEN 'accepted' THEN 2 ELSE 1 END DESC,occurred_at DESC LIMIT 1`)
    .get(tenantId, row.id) as { provider_message_id: string; status: string; occurred_at: string; error_code: string | null; error_message: string | null } | undefined : undefined;
  const triggerEvidence = safeRecord(row.trigger_evidence_json);
  return {
    id: row.id, purchaseOrderId: row.purchase_order_id, purchaseOrderNumber: po?.number ?? po?.externalId ?? row.purchase_order_id,
    supplierId: row.supplier_id, supplierName: supplier?.name ?? row.supplier_id, channel: row.channel, recipient: row.recipient,
    subject: row.subject, body: row.body, category: row.category, triggerEvidence,
    decisionContext: buildDraftDecisionContext(db, tenantId, row, triggerEvidence),
    senderIdentity: hasSenderIdentity(row) ? {
      displayName: row.sender_name,
      title: row.sender_title,
      organizationName: row.sender_organization,
    } : null,
    status: row.status, version: row.version, outboxId: row.outbox_id, delivery: outbox ? {
      status: outbox.status, error: typeof outboxJson?.['error'] === 'string' ? outboxJson['error'] : null, attempts: Number(outbox.attempt ?? 0), dispatchedAt: outbox.dispatched_at, failedAt: outbox.failed_at, updatedAt: outbox.updated_at,
    } : null,
    providerDelivery: whatsappDelivery ? { messageId: whatsappDelivery.provider_message_id, status: whatsappDelivery.status, occurredAt: whatsappDelivery.occurred_at, errorCode: whatsappDelivery.error_code, errorMessage: whatsappDelivery.error_message } : null,
    amountTotal: po?.amountTotal ?? null, currency: po?.currency ?? null, promisedAt: po?.promisedAt ?? null,
    createdBy: row.created_by, reviewedBy: row.reviewed_by, createdAt: row.created_at, updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at, sentAt: row.sent_at,
  };
}

function buildDraftDecisionContext(db: DatabaseSync, tenantId: string, row: DraftRow, evidence: Record<string, unknown>): DraftDecisionContext {
  const missingFields = supplierReplyFields(evidence['confirmationMissingFields']);
  const sourceCommunication = trustedSourceCommunication(db, tenantId, row, evidence['sourceCommunicationId']);
  if (sourceCommunication) {
    const missing = missingFields.map(supplierReplyFieldLabel).join('、');
    return {
      source: 'supplier_reply',
      label: '回信待补充',
      summary: missing ? `已收到供应商回复，仍需补充${missing}` : '已收到供应商回复，等待人工核对完整确认事实',
      ruleId: null,
      dueAt: null,
      missingFields,
      sourceCommunication,
    };
  }

  const rule = textValue(evidence['rule']) ?? textValue(evidence['slaRuleId']);
  const dueAt = isoValue(evidence['dueAt']) ?? isoValue(evidence['promisedAt']);
  const daysToDue = finiteNumber(evidence['daysToDue']);
  const hoursWithoutCommitment = finiteNumber(evidence['hoursWithoutCommitment']);
  const label = row.category === 'acknowledgement_followup'
    ? '确认催办'
    : row.category === 'production_progress_followup'
      ? '生产进度跟进'
      : row.category === 'dispatch_followup'
        ? '发运跟进'
        : row.category === 'grn_followup'
          ? '收货跟进'
          : '交付升级';
  let summary = '真实采购订单命中已发布的 SLA 规则';
  if (daysToDue !== null) {
    summary = daysToDue < 0
      ? `承诺交期已逾期 ${Math.abs(Math.trunc(daysToDue))} 天，触发${label}`
      : `距承诺交期还有 ${Math.trunc(daysToDue)} 天，已进入${label}窗口`;
  } else if (hoursWithoutCommitment !== null) {
    summary = `供应商确认已等待 ${Math.max(0, Math.trunc(hoursWithoutCommitment))} 小时，触发${label}`;
  } else if (dueAt) {
    summary = `SLA 截止时间 ${dueAt}，当前需要${label}`;
  }
  return {
    source: row.trigger_code.startsWith('sla:') || rule ? 'sla_policy' : 'purchase_order',
    label,
    summary,
    ruleId: rule,
    dueAt,
    missingFields: [],
    sourceCommunication: null,
  };
}

function trustedSourceCommunication(db: DatabaseSync, tenantId: string, row: DraftRow, value: unknown): DraftDecisionContext['sourceCommunication'] {
  const id = textValue(value);
  if (!id) return null;
  const stored = db.prepare(`SELECT json FROM procurement_documents WHERE tenant_id=? AND kind='communication' AND id=?`)
    .get(tenantId, id) as { json: string } | undefined;
  if (!stored) return null;
  const communication = safeJson(stored.json) as Communication | undefined;
  if (!communication
    || communication.id !== id
    || communication.tenantId !== tenantId
    || communication.businessObjectId !== row.purchase_order_id
    || communication.businessObjectType !== 'purchase_order'
    || communication.supplierId !== row.supplier_id
    || communication.direction !== 'inbound'
    || communication.status !== 'received') return null;
  return {
    id,
    from: textValue(communication.from),
    subject: textValue(communication.subject),
    receivedAt: communication.receivedAt ?? communication.occurredAt,
    messageId: textValue(communication.messageId),
    body: communication.body,
  };
}

function supplierReplyFields(value: unknown): SupplierReplyField[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<SupplierReplyField>(['quantity', 'unit_price', 'promised_date']);
  return [...new Set(value.filter((field): field is SupplierReplyField => typeof field === 'string' && allowed.has(field as SupplierReplyField)))];
}

function supplierReplyFieldLabel(field: SupplierReplyField): string {
  if (field === 'quantity') return '确认数量';
  if (field === 'unit_price') return '确认单价';
  return '承诺交期';
}

function safeRecord(value: string): Record<string, unknown> {
  const parsed = safeJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isoValue(value: unknown): string | null {
  const text = textValue(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function getDraft(db: DatabaseSync, tenantId: string, id: string): DraftRow | undefined {
  return db.prepare(`SELECT * FROM procurement_message_drafts WHERE tenant_id=? AND id=?`).get(tenantId, id) as unknown as DraftRow | undefined;
}
function getActiveCommunicationIdentity(db: DatabaseSync, tenantId: string): ProcurementCommunicationIdentity | null {
  const identity = getProcurementCommunicationIdentity(db, tenantId);
  return identity?.status === 'active' ? identity : null;
}
function hasSenderIdentity(row: DraftRow): row is DraftRow & { sender_name: string; sender_title: string; sender_organization: string } {
  return Boolean(row.sender_name?.trim() && row.sender_title?.trim() && row.sender_organization?.trim());
}
function listEvents(db: DatabaseSync, tenantId: string, draftId: string): unknown[] {
  const rows = db.prepare(`SELECT id,actor_id,action,detail_json,created_at FROM procurement_message_draft_events WHERE tenant_id=? AND draft_id=? ORDER BY created_at,id`).all(tenantId, draftId) as Array<{ id: string; actor_id: string; action: string; detail_json: string; created_at: string }>;
  const providerRows = db.prepare(`SELECT event_fingerprint,provider_message_id,status,occurred_at,error_code,error_message
    FROM procurement_whatsapp_delivery_events WHERE tenant_id=? AND draft_id=? ORDER BY occurred_at,event_fingerprint`)
    .all(tenantId, draftId) as Array<{ event_fingerprint: string; provider_message_id: string; status: string; occurred_at: string; error_code: string | null; error_message: string | null }>;
  return [
    ...rows.map((row) => ({ id: row.id, actorId: row.actor_id, action: row.action, detail: safeJson(row.detail_json), createdAt: row.created_at })),
    ...providerRows.map((row) => ({
      id: `whatsapp-delivery:${row.event_fingerprint}`,
      actorId: 'connector:whatsapp',
      action: `whatsapp_${row.status}`,
      detail: { messageId: row.provider_message_id, errorCode: row.error_code, errorMessage: row.error_message },
      createdAt: row.occurred_at,
    })),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}
function insertEvent(db: DatabaseSync, tenantId: string, draftId: string, actorId: string, action: string, detail: unknown, at: string): void {
  db.prepare(`INSERT INTO procurement_message_draft_events (tenant_id,id,draft_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(tenantId, `message-draft-event:${randomUUID()}`, draftId, actorId, action, JSON.stringify(detail), at);
}
function queryStatus(req: IncomingMessage): DraftStatus | 'all' {
  const value = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('status') ?? 'all';
  if (!['all', 'draft', 'approved_queued', 'sent', 'discarded'].includes(value)) throw new DraftInputError('status 无效');
  return value as DraftStatus | 'all';
}
function idempotencyKey(req: IncomingMessage): string {
  const raw = req.headers['idempotency-key']; const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.trim() || value.trim().length > 200) throw new DraftInputError('Idempotency-Key 必填');
  return value.trim();
}
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''; for await (const chunk of req) { raw += String(chunk); if (raw.length > 100_000) throw new DraftInputError('请求体过大'); }
  try { const value = JSON.parse(raw || '{}') as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; }
  catch { throw new DraftInputError('请求体必须是 JSON 对象'); }
}
function requiredText(value: unknown, field: string, max: number): string { if (typeof value !== 'string' || !value.trim()) throw new DraftInputError(`${field} 必填`); if (value.trim().length > max) throw new DraftInputError(`${field} 超过 ${max} 字符`); return value.trim(); }
function positiveInteger(value: unknown, field: string): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new DraftInputError(`${field} 必须是正整数`); return Number(value); }
function safeJson(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { return {}; } }
function sendJson(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); }
function forbidden(res: ServerResponse, message: string): true { sendJson(res, 403, { error: message, code: 'FORBIDDEN' }); return true; }
function sendDraftError(res: ServerResponse, error: unknown): void {
  if (error instanceof DraftNotFoundError) return sendJson(res, 404, { error: error.message, code: 'MESSAGE_DRAFT_NOT_FOUND' });
  if (error instanceof DraftVersionError) return sendJson(res, 409, { error: error.message, code: 'MESSAGE_DRAFT_VERSION_CONFLICT', currentVersion: error.currentVersion });
  if (error instanceof DraftIdentityMissingError) return sendJson(res, 409, { error: error.message, code: 'COMMUNICATION_IDENTITY_MISSING' });
  if (error instanceof DraftConflictError) return sendJson(res, 409, { error: error.message, code: 'MESSAGE_DRAFT_STATE_CONFLICT' });
  if (error instanceof DraftInputError) return sendJson(res, 422, { error: error.message, code: 'INVALID_MESSAGE_DRAFT_INPUT' });
  throw error;
}
class DraftInputError extends Error {}
class DraftConflictError extends Error {}
class DraftIdentityMissingError extends Error { constructor() { super('草稿没有可审计的供应商可见发件人快照，禁止审批外发；请配置采购沟通身份后重新生成草稿'); } }
class DraftNotFoundError extends Error { constructor() { super('邮件草稿不存在'); } }
class DraftVersionError extends Error { constructor(readonly currentVersion: number) { super(`邮件草稿版本已变更，当前版本为 ${currentVersion}`); } }

export function messageDraftPayloadHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
