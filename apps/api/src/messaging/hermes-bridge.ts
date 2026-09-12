import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { isValidMessagingChannel, type InboundMessageEnvelope, type MessageAttachmentPayload } from '@readywork/messaging';
import { HermesRepository } from './hermes-repository.js';

export const HERMES_BRIDGE_VERSION = 'readywork.hermes.bridge.v1';
const INBOUND_PATH = '/api/integrations/hermes/v1/inbound';
const MAX_CLOCK_SKEW_MS = 300_000;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

export interface HermesInboundRuntime {
  ingest(envelope: InboundMessageEnvelope, attachments: readonly MessageAttachmentPayload[]): Promise<{
    inboundId: string;
    replayed: boolean;
  }>;
}

export interface HermesBridgeContext {
  readonly db: DatabaseSync;
  readonly bridgeSecret: string;
  readonly runtimeForTenant: (tenantId: string) => HermesInboundRuntime;
  readonly now?: () => string;
}

export class HermesBridgeRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'HermesBridgeRequestError';
  }
}

export function verifyHermesBridgeRequest(input: {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders | Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: Buffer;
  readonly secret: string;
  readonly now?: () => string;
}): { timestamp: string; nonce: string } {
  if (input.secret.length < 32) throw new HermesBridgeRequestError('Hermes Bridge 共享密钥未安全配置', 503, 'BRIDGE_UNCONFIGURED');
  const version = header(input.headers, 'x-readywork-bridge-version');
  if (version !== HERMES_BRIDGE_VERSION) throw new HermesBridgeRequestError('Hermes Bridge 合同版本不受支持', 400, 'BRIDGE_VERSION_UNSUPPORTED');
  const timestamp = header(input.headers, 'x-readywork-timestamp');
  const nonce = header(input.headers, 'x-readywork-nonce');
  const signature = header(input.headers, 'x-readywork-signature');
  if (!timestamp || !nonce || !signature) throw new HermesBridgeRequestError('Hermes Bridge 认证头不完整', 401, 'BRIDGE_AUTH_REQUIRED');
  if (!/^[A-Za-z0-9_-]{8,160}$/u.test(nonce)) throw new HermesBridgeRequestError('Hermes Bridge nonce 无效', 400, 'BRIDGE_NONCE_INVALID');
  const numericTimestamp = Number(timestamp);
  const timestampMs = numericTimestamp < 10_000_000_000 ? numericTimestamp * 1_000 : numericTimestamp;
  const nowMs = Date.parse((input.now ?? (() => new Date().toISOString()))());
  if (!Number.isFinite(timestampMs) || !Number.isFinite(nowMs) || Math.abs(nowMs - timestampMs) > MAX_CLOCK_SKEW_MS) {
    throw new HermesBridgeRequestError('Hermes Bridge 时间戳已过期或超前', 401, 'BRIDGE_TIMESTAMP_INVALID');
  }
  if (!/^[a-f0-9]{64}$/u.test(signature)) throw new HermesBridgeRequestError('Hermes Bridge 签名格式无效', 401, 'BRIDGE_SIGNATURE_INVALID');
  const signingInput = [input.method.toUpperCase(), input.path, timestamp, nonce, input.rawBody.toString('utf8')].join('\n');
  const expected = createHmac('sha256', input.secret).update(signingInput).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)) {
    throw new HermesBridgeRequestError('Hermes Bridge 签名不匹配', 401, 'BRIDGE_SIGNATURE_INVALID');
  }
  return { timestamp, nonce };
}

export async function ingestHermesInboundBody(
  rawBody: Buffer,
  nonce: string,
  context: Omit<HermesBridgeContext, 'bridgeSecret'> & { readonly bridgeSecret?: string },
): Promise<{ persisted: true; inboundId: string; replayed: boolean }> {
  const now = (context.now ?? (() => new Date().toISOString()))();
  const body = parseObject(rawBody);
  const requestId = requiredString(body.requestId, 'requestId', 8, 180);
  const profile = requiredString(body.profile, 'profile', 27, 27);
  if (!/^rw-[a-f0-9]{24}$/u.test(profile)) throw new HermesBridgeRequestError('Hermes profile 标识无效', 400, 'BRIDGE_PROFILE_INVALID');
  const mapping = context.db.prepare(
    'SELECT tenant_id FROM hermes_tenant_profiles WHERE profile_id=?',
  ).get(profile) as { tenant_id: string } | undefined;
  if (!mapping) throw new HermesBridgeRequestError('Hermes profile 未映射到 Readywork 租户', 403, 'BRIDGE_PROFILE_UNKNOWN');
  const event = objectValue(body.event, 'event');
  const platform = requiredString(event.platform, 'event.platform', 1, 96);
  if (!isValidMessagingChannel(platform)) throw new HermesBridgeRequestError('Hermes 入站平台标识无效', 400, 'BRIDGE_PLATFORM_INVALID');
  const providerMessageId = requiredString(event.messageId, 'event.messageId', 1, 500);
  const sender = objectValue(event.sender, 'event.sender');
  const attachments = parseAttachments(body.attachments);
  const occurredAt = requiredIso(event.occurredAt, 'event.occurredAt');
  const requestFingerprint = createHash('sha256').update(rawBody).digest('hex');
  const rawFingerprint = createHash('sha256').update(stableJson({
    profile,
    event,
    attachments: attachments.map(({ content: _content, ...descriptor }) => descriptor),
  })).digest('hex');
  const envelope: InboundMessageEnvelope = {
    id: `hermes:${createHash('sha256').update(`${profile}\n${platform}\n${providerMessageId}`).digest('hex')}`,
    tenantId: mapping.tenant_id,
    adapterId: `hermes:${platform}`,
    channel: platform,
    provider: 'hermes',
    providerMessageId,
    ...(optionalString(event.conversationId, 500) ? { conversationId: optionalString(event.conversationId, 500) } : {}),
    ...(optionalString(event.inReplyTo, 500) ? { inReplyTo: optionalString(event.inReplyTo, 500) } : {}),
    references: stringArray(event.references, 100, 500),
    sender: {
      address: requiredString(sender.address, 'event.sender.address', 1, 500),
      ...(optionalString(sender.displayName, 300) ? { displayName: optionalString(sender.displayName, 300) } : {}),
    },
    recipients: arrayValue(event.recipients).map((recipient, index) => {
      const row = objectValue(recipient, `event.recipients[${index}]`);
      return {
        address: requiredString(row.address, `event.recipients[${index}].address`, 1, 500),
        ...(optionalString(row.displayName, 300) ? { displayName: optionalString(row.displayName, 300) } : {}),
      };
    }),
    ...(optionalString(event.subject, 1_000) ? { subject: optionalString(event.subject, 1_000) } : {}),
    text: typeof event.text === 'string' ? event.text.slice(0, 2_000_000) : '',
    attachments: attachments.map(({ content: _content, ...descriptor }) => descriptor),
    occurredAt,
    receivedAt: now,
    rawFingerprint,
  };
  const repository = new HermesRepository(context.db, mapping.tenant_id);

  context.db.exec('BEGIN IMMEDIATE');
  try {
    const repeated = context.db.prepare(`SELECT 1 FROM hermes_bridge_nonces
      WHERE tenant_id=? AND nonce=?`).get(mapping.tenant_id, nonce);
    if (repeated) throw new HermesBridgeRequestError('Hermes Bridge nonce 已被使用', 409, 'BRIDGE_REPLAY');
    context.db.prepare(`DELETE FROM hermes_bridge_nonces WHERE expires_at<=?`).run(now);
    context.db.prepare(`INSERT INTO hermes_bridge_nonces
      (tenant_id,nonce,expires_at,created_at) VALUES (?,?,?,?)`).run(
        mapping.tenant_id,
        nonce,
        new Date(Date.parse(now) + MAX_CLOCK_SKEW_MS).toISOString(),
        now,
      );
    const ingested = await context.runtimeForTenant(mapping.tenant_id).ingest(envelope, attachments);
    repository.recordBridgeReceipt({
      requestId,
      requestFingerprint,
      inboundId: ingested.inboundId,
      result: { persisted: true, inboundId: ingested.inboundId, replayed: ingested.replayed },
      createdAt: now,
    });
    context.db.exec('COMMIT');
    return { persisted: true, inboundId: ingested.inboundId, replayed: ingested.replayed };
  } catch (error) {
    context.db.exec('ROLLBACK');
    throw error;
  }
}

export async function handleHermesIntegrationRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  context: HermesBridgeContext,
): Promise<boolean> {
  if (path !== INBOUND_PATH) return false;
  if (method !== 'POST') return json(res, 405, { error: 'Hermes 入站只支持 POST', code: 'METHOD_NOT_ALLOWED' });
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
    const verified = verifyHermesBridgeRequest({
      method,
      path,
      headers: req.headers,
      rawBody,
      secret: context.bridgeSecret,
      now: context.now,
    });
    const result = await ingestHermesInboundBody(rawBody, verified.nonce, context);
    return json(res, 200, result);
  } catch (error) {
    if (error instanceof HermesBridgeRequestError) return json(res, error.status, { error: error.message, code: error.code });
    return json(res, 400, { error: 'Hermes 入站载荷无效', code: 'BRIDGE_INVALID_BODY' });
  }
}

function parseAttachments(value: unknown): MessageAttachmentPayload[] {
  const rows = arrayValue(value);
  if (rows.length > 20) throw new HermesBridgeRequestError('Hermes 入站附件数量超限', 413, 'BRIDGE_ATTACHMENTS_TOO_LARGE');
  let total = 0;
  return rows.map((value, index) => {
    const row = objectValue(value, `attachments[${index}]`);
    const content = Buffer.from(requiredString(row.contentBase64, `attachments[${index}].contentBase64`, 0, 15_000_000), 'base64');
    const sizeBytes = Number(row.sizeBytes);
    const sha256 = requiredString(row.sha256, `attachments[${index}].sha256`, 64, 64);
    if (!/^[a-f0-9]{64}$/u.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0
      || sizeBytes > MAX_ATTACHMENT_BYTES || content.byteLength !== sizeBytes
      || createHash('sha256').update(content).digest('hex') !== sha256) {
      throw new HermesBridgeRequestError('Hermes 入站附件描述符与内容不一致', 400, 'BRIDGE_ATTACHMENT_INVALID');
    }
    total += sizeBytes;
    if (total > MAX_ATTACHMENTS_BYTES) throw new HermesBridgeRequestError('Hermes 入站附件总量超限', 413, 'BRIDGE_ATTACHMENTS_TOO_LARGE');
    return {
      id: requiredString(row.id, `attachments[${index}].id`, 1, 180),
      name: requiredString(row.name, `attachments[${index}].name`, 1, 500),
      contentType: requiredString(row.contentType, `attachments[${index}].contentType`, 1, 200),
      sizeBytes,
      sha256,
      content,
    };
  });
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new HermesBridgeRequestError('Hermes 入站请求体过大', 413, 'BRIDGE_BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseObject(buffer: Buffer): Record<string, unknown> {
  try {
    const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    return objectValue(parsed, 'body');
  } catch (error) {
    if (error instanceof HermesBridgeRequestError) throw error;
    throw new HermesBridgeRequestError('Hermes 入站必须是 JSON 对象', 400, 'BRIDGE_INVALID_JSON');
  }
}

function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HermesBridgeRequestError(`${name} 必须是对象`, 400, 'BRIDGE_INVALID_BODY');
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new HermesBridgeRequestError(`${name} 无效`, 400, 'BRIDGE_INVALID_BODY');
  }
  return value;
}

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] {
  return arrayValue(value).slice(0, maxItems).filter((item): item is string => typeof item === 'string')
    .map((item) => item.slice(0, maxLength));
}

function requiredIso(value: unknown, name: string): string {
  const text = requiredString(value, name, 20, 40);
  if (!Number.isFinite(Date.parse(text))) throw new HermesBridgeRequestError(`${name} 不是有效时间`, 400, 'BRIDGE_INVALID_BODY');
  return text;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function header(headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string {
  const value = headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
}

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
}
