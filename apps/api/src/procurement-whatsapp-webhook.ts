import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Communication } from '@readywork/core';
import type { ConnectorControlPlane } from './connector-control-plane.js';
import { normalizeWhatsAppRecipient } from './whatsapp-cloud.js';

export interface WhatsAppWebhookResult {
  status: number;
  body: Record<string, unknown>;
}

type Credential = { verifyToken: string; appSecret: string };
type LinkedDraft = { draft_id: string; outbox_id: string | null; purchase_order_id: string; supplier_id: string; recipient: string };

export function verifyWhatsAppWebhookSubscription(input: {
  controlPlane: ConnectorControlPlane;
  credentialId: string;
  mode?: string;
  verifyToken?: string;
  challenge?: string;
}): { status: number; challenge?: string; error?: string } {
  const credential = whatsappCredential(input.controlPlane, input.credentialId);
  if (!credential) return { status: 404, error: 'WhatsApp 凭据不存在或无法解密' };
  if (input.mode !== 'subscribe' || !input.challenge || !secureEqual(input.verifyToken ?? '', credential.verifyToken)) {
    return { status: 403, error: 'Webhook 验证失败' };
  }
  return { status: 200, challenge: input.challenge };
}

export function processWhatsAppWebhook(input: {
  db: DatabaseSync;
  tenantId: string;
  credentialId: string;
  controlPlane: ConnectorControlPlane;
  rawBody: Buffer;
  signature?: string;
  receivedAt?: Date;
}): WhatsAppWebhookResult {
  const credential = whatsappCredential(input.controlPlane, input.credentialId);
  if (!credential) return { status: 404, body: { ok: false, error: 'WhatsApp 凭据不存在或无法解密' } };
  if (!verifySignature(input.rawBody, input.signature, credential.appSecret)) {
    return { status: 401, body: { ok: false, error: 'WhatsApp Webhook 签名无效' } };
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.rawBody.toString('utf8')) as unknown;
    if (!isRecord(parsed)) throw new Error('invalid payload');
    payload = parsed;
  } catch {
    return { status: 400, body: { ok: false, error: 'Webhook 请求体不是有效 JSON 对象' } };
  }

  const receivedAt = (input.receivedAt ?? new Date()).toISOString();
  const rawHash = createHash('sha256').update(input.rawBody).digest('hex');
  let deliveryEvents = 0;
  let inboundMessages = 0;
  let linkedMessages = 0;
  input.db.exec('BEGIN IMMEDIATE');
  try {
    for (const value of webhookValues(payload)) {
      for (const rawStatus of arrayOfRecords(value['statuses'])) {
        const providerMessageId = boundedText(rawStatus['id'], 1_024);
        const status = boundedText(rawStatus['status'], 32);
        if (!providerMessageId || !isDeliveryStatus(status)) continue;
        const occurredAt = metaTimestamp(rawStatus['timestamp'], receivedAt);
        const linked = linkedDraft(input.db, input.tenantId, providerMessageId);
        const error = status === 'failed' ? providerError(rawStatus['errors']) : {};
        const fingerprint = createHash('sha256')
          .update(`${providerMessageId}|${status}|${occurredAt}|${error.code ?? ''}`)
          .digest('hex');
        const inserted = input.db.prepare(`INSERT OR IGNORE INTO procurement_whatsapp_delivery_events
          (tenant_id,event_fingerprint,provider_message_id,draft_id,outbox_id,status,occurred_at,error_code,error_message,raw_hash,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          input.tenantId, fingerprint, providerMessageId, linked?.draft_id ?? null, linked?.outbox_id ?? null,
          status, occurredAt, error.code ?? null, error.message ?? null, rawHash, receivedAt,
        );
        deliveryEvents += Number(inserted.changes);
      }

      for (const rawMessage of arrayOfRecords(value['messages'])) {
        const providerMessageId = boundedText(rawMessage['id'], 1_024);
        const fromPhone = normalizedPhone(rawMessage['from']);
        if (!providerMessageId || !fromPhone) continue;
        const context = isRecord(rawMessage['context']) ? rawMessage['context'] : {};
        const contextMessageId = boundedText(context['id'], 1_024);
        const linked = contextMessageId ? linkedDraft(input.db, input.tenantId, contextMessageId) : undefined;
        const trustedLink = linked && normalizedPhone(linked.recipient) === fromPhone ? linked : undefined;
        const occurredAt = metaTimestamp(rawMessage['timestamp'], receivedAt);
        const body = inboundBody(rawMessage);
        const communicationId = trustedLink ? `communication:whatsapp:${providerMessageId}` : null;
        const inserted = input.db.prepare(`INSERT OR IGNORE INTO procurement_whatsapp_inbound_messages
          (tenant_id,provider_message_id,context_message_id,from_phone,body,occurred_at,communication_id,po_id,supplier_id,raw_hash,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          input.tenantId, providerMessageId, contextMessageId ?? null, fromPhone, body, occurredAt,
          communicationId, trustedLink?.purchase_order_id ?? null, trustedLink?.supplier_id ?? null, rawHash, receivedAt,
        );
        if (Number(inserted.changes) === 0) continue;
        inboundMessages += 1;
        if (!trustedLink || !communicationId) continue;
        const poExists = input.db.prepare(`SELECT 1 AS ok FROM procurement_documents
          WHERE tenant_id=? AND kind='purchase_order' AND id=?`).get(input.tenantId, trustedLink.purchase_order_id);
        if (!poExists) continue;
        const communication: Communication = {
          id: communicationId,
          tenantId: input.tenantId,
          sourceSystem: 'meta-whatsapp-cloud',
          externalId: providerMessageId,
          status: 'received',
          createdAt: receivedAt,
          updatedAt: receivedAt,
          businessObjectId: trustedLink.purchase_order_id,
          businessObjectType: 'purchase_order',
          supplierId: trustedLink.supplier_id,
          channel: 'whatsapp',
          direction: 'inbound',
          messageId: providerMessageId,
          provider: 'meta-whatsapp-cloud',
          from: fromPhone,
          body,
          attachmentIds: [],
          occurredAt,
          receivedAt,
        };
        input.db.prepare(`INSERT OR IGNORE INTO procurement_documents
          (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
          VALUES (?,'communication',?,?,?,?,1,?,?,?)`).run(
          input.tenantId, communication.id, communication.sourceSystem, communication.externalId,
          communication.status, JSON.stringify(communication), communication.createdAt, communication.updatedAt,
        );
        linkedMessages += 1;
      }
    }
    input.db.exec('COMMIT');
  } catch (error) {
    input.db.exec('ROLLBACK');
    throw error;
  }
  return { status: 200, body: { ok: true, deliveryEvents, inboundMessages, linkedMessages } };
}

function whatsappCredential(controlPlane: ConnectorControlPlane, credentialId: string): Credential | undefined {
  const view = controlPlane.listCredentials().find((item) => item.id === credentialId && item.connectorId === 'whatsapp');
  const value = view ? controlPlane.getCredential(credentialId) : undefined;
  const verifyToken = boundedText(value?.['verifyToken'], 1_024);
  const appSecret = boundedText(value?.['appSecret'], 1_024);
  return verifyToken && appSecret ? { verifyToken, appSecret } : undefined;
}

function webhookValues(payload: Record<string, unknown>): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const entry of arrayOfRecords(payload['entry'])) {
    for (const change of arrayOfRecords(entry['changes'])) {
      if (isRecord(change['value'])) values.push(change['value']);
    }
  }
  return values;
}

function linkedDraft(db: DatabaseSync, tenantId: string, providerMessageId: string): LinkedDraft | undefined {
  return db.prepare(`SELECT e.draft_id,e.outbox_id,d.purchase_order_id,d.supplier_id,d.recipient
    FROM procurement_whatsapp_delivery_events e
    JOIN procurement_message_drafts d ON d.tenant_id=e.tenant_id AND d.id=e.draft_id
    WHERE e.tenant_id=? AND e.provider_message_id=? AND e.draft_id IS NOT NULL
    ORDER BY e.created_at DESC LIMIT 1`).get(tenantId, providerMessageId) as LinkedDraft | undefined;
}

function verifySignature(rawBody: Buffer, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const actual = signature.slice(7).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(actual)) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return secureEqual(actual, expected);
}

function secureEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function inboundBody(message: Record<string, unknown>): string {
  const text = isRecord(message['text']) ? boundedText(message['text']['body'], 4_096) : undefined;
  if (text) return text;
  const type = boundedText(message['type'], 50) ?? 'unknown';
  return `[WhatsApp ${type} 消息；正文未提供]`;
}

function providerError(value: unknown): { code?: string; message?: string } {
  const error = arrayOfRecords(value)[0];
  if (!error) return {};
  const code = boundedText(error['code'], 100);
  const data = isRecord(error['error_data']) ? error['error_data'] : {};
  const raw = boundedText(data['details'], 500) ?? boundedText(error['message'], 500) ?? boundedText(error['title'], 500);
  const message = raw?.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(token|secret|password|credential)(\s*[=:]\s*)([^\s,;}&]+)/gi, '$1$2[REDACTED]');
  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

function metaTimestamp(value: unknown, fallback: string): string {
  const seconds = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback;
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function normalizedPhone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try { return normalizeWhatsAppRecipient(value); } catch { return undefined; }
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  return text && text.length <= max ? text : undefined;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isDeliveryStatus(value: unknown): value is 'sent' | 'delivered' | 'read' | 'failed' {
  return value === 'sent' || value === 'delivered' || value === 'read' || value === 'failed';
}
