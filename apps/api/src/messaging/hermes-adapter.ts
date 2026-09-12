import { createHash, createHmac, randomUUID } from 'node:crypto';
import type {
  AdapterHealth,
  AdapterSendResult,
  MessageDeliveryRequest,
  MessagingAdapter,
  MessagingCapability,
  MessagingChannel,
} from '@readywork/messaging';
import { isValidMessagingChannel } from '@readywork/messaging';
import { HERMES_BRIDGE_VERSION } from './hermes-bridge.js';

export interface HermesMessagingAdapterOptions {
  readonly baseUrl: string;
  readonly secret: string;
  readonly profile: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => string;
  readonly nonce?: () => string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export class HermesMessagingAdapter implements MessagingAdapter {
  readonly id: string;
  readonly channel: MessagingChannel;
  readonly provider = 'hermes-gateway';
  readonly capabilities: readonly MessagingCapability[] = [
    'send_text',
    'send_attachments',
    'receive',
    'threads',
    'delivery_receipts',
  ];
  private readonly baseUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => string;
  private readonly nonce: () => string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    channel: string,
    private readonly options: HermesMessagingAdapterOptions,
    adapterId = `hermes:${channel}`,
  ) {
    if (!isValidMessagingChannel(channel) || channel === 'readywork_bridge') throw new Error('Hermes 消息渠道标识无效');
    if (options.secret.length < 32) throw new Error('Hermes Bridge 共享密钥至少需要 32 个字符');
    if (!/^rw-[a-f0-9]{24}$/u.test(options.profile)) throw new Error('Hermes profile 标识无效');
    this.channel = channel;
    this.id = adapterId;
    this.baseUrl = new URL(options.baseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.nonce = options.nonce ?? randomUUID;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
  }

  async health(): Promise<AdapterHealth> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5_000));
    try {
      const response = await this.fetcher(new URL('/health', this.baseUrl), {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, message: 'Hermes Bridge 健康检查未通过' };
      const body = await response.json() as Record<string, unknown>;
      return body.ok === true
        ? { ok: true }
        : { ok: false, message: 'Hermes Bridge 当前处于阻塞状态' };
    } catch {
      return { ok: false, message: 'Hermes Bridge 当前不可达' };
    } finally {
      clearTimeout(timer);
    }
  }

  async send(request: MessageDeliveryRequest): Promise<AdapterSendResult> {
    if (request.channel !== this.channel || request.adapterId !== this.id) {
      return { kind: 'failed_before_dispatch', error: '投递请求与 Hermes 渠道适配器不匹配' };
    }
    if (request.recipients.length !== 1 || !request.recipients[0]?.address.trim()) {
      return { kind: 'failed_before_dispatch', error: 'Hermes 渠道投递必须且只能指定一个目标' };
    }
    for (const attachment of request.attachments) {
      if (attachment.content.byteLength !== attachment.sizeBytes
        || createHash('sha256').update(attachment.content).digest('hex') !== attachment.sha256) {
        return { kind: 'failed_before_dispatch', error: '投递附件与冻结描述符不一致' };
      }
    }
    const deliveryId = `readywork:${createHash('sha256').update([
      request.tenantId,
      request.adapterId,
      request.idempotencyKey,
    ].join('\n')).digest('hex')}`;
    const payload = {
      deliveryId,
      profile: this.options.profile,
      platform: this.channel,
      target: request.recipients[0].address,
      text: request.text,
      replyTo: request.thread?.inReplyTo ?? null,
      metadata: {
        references: [...(request.thread?.references ?? [])],
        correlation_id: request.trace.correlationId,
        source: request.trace.source,
        source_id: request.trace.sourceId,
      },
      attachments: request.attachments.map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        sha256: attachment.sha256,
        contentBase64: attachment.content.toString('base64'),
      })),
    };
    const body = JSON.stringify(payload);
    const timestamp = String(Date.parse(this.now()));
    const nonce = this.nonce();
    const path = '/readywork/v1/deliveries';
    const signature = createHmac('sha256', this.options.secret).update([
      'POST',
      path,
      timestamp,
      nonce,
      body,
    ].join('\n')).digest('hex');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetcher(new URL(path, this.baseUrl), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'X-Readywork-Bridge-Version': HERMES_BRIDGE_VERSION,
          'X-Readywork-Timestamp': timestamp,
          'X-Readywork-Nonce': nonce,
          'X-Readywork-Signature': signature,
        },
        body,
        signal: controller.signal,
      });
      const result = await readBridgeResult(response, this.maxResponseBytes);
      if (!response.ok && !isBridgeResult(result)) {
        return { kind: 'failed_before_dispatch', error: 'Hermes Bridge 拒绝了投递请求' };
      }
      return mapBridgeResult(result);
    } catch (error) {
      if (isConnectionRefused(error)) {
        return { kind: 'retryable_before_dispatch', error: 'Hermes Bridge 当前不可达' };
      }
      return {
        kind: 'unknown_after_dispatch',
        error: timedOut
          ? 'Hermes Bridge 响应超时，外部投递结果未知'
          : 'Hermes Bridge 响应中断，外部投递结果未知',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBridgeResult(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('oversized');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error('oversized');
  const parsed = JSON.parse(buffer.toString('utf8') || '{}') as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
  return parsed as Record<string, unknown>;
}

function isBridgeResult(value: Record<string, unknown>): boolean {
  return ['accepted', 'retryable_before_dispatch', 'failed_before_dispatch', 'unknown_after_dispatch'].includes(String(value.kind));
}

function mapBridgeResult(value: Record<string, unknown>): AdapterSendResult {
  const kind = String(value.kind);
  if (kind === 'accepted') {
    const providerMessageId = typeof value.providerMessageId === 'string' ? value.providerMessageId.trim() : '';
    if (!providerMessageId) return { kind: 'unknown_after_dispatch', error: 'Hermes 投递成功但缺少平台消息标识' };
    const acceptedAt = typeof value.acceptedAt === 'string' && Number.isFinite(Date.parse(value.acceptedAt))
      ? value.acceptedAt
      : new Date().toISOString();
    return { kind: 'accepted', providerMessageId, acceptedAt };
  }
  const error = safeError(value.error);
  if (kind === 'retryable_before_dispatch') return { kind, error };
  if (kind === 'failed_before_dispatch') return { kind, error };
  if (kind === 'unknown_after_dispatch') return { kind, error };
  return { kind: 'unknown_after_dispatch', error: 'Hermes Bridge 返回了无法确认的投递结果' };
}

function safeError(value: unknown): string {
  const text = typeof value === 'string' ? value : 'Hermes Bridge 投递失败';
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[已隐藏]')
    .replace(/\b(token|secret|password|authorization)\s*[:=]\s*\S+/giu, '$1=[已隐藏]')
    .slice(0, 1_000);
}

function isConnectionRefused(error: unknown): boolean {
  const candidate = error as { cause?: { code?: unknown }; code?: unknown } | null;
  const code = String(candidate?.cause?.code ?? candidate?.code ?? '');
  return ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code);
}
