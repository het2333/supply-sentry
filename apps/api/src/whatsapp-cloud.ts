export type WhatsAppTemplateParameterKey = 'po_number' | 'supplier_name' | 'message';

export interface WhatsAppCloudCredentials {
  phoneNumberId: string;
  businessAccountId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  apiVersion: string;
  templateName: string;
  languageCode: string;
  templateParameterKeys: WhatsAppTemplateParameterKey[];
}

export interface WhatsAppTemplateMessageInput {
  to: string;
  poNumber: string;
  supplierName: string;
  message: string;
  idempotencyKey: string;
}

type FetchLike = typeof fetch;

export class WhatsAppCloudApiClient {
  readonly credentials: WhatsAppCloudCredentials;

  constructor(value: Record<string, unknown>, private readonly fetchImpl: FetchLike = fetch) {
    this.credentials = parseWhatsAppCredentials(value);
  }

  async healthCheck(timeoutMs = 10_000): Promise<{ profile: Record<string, unknown>; template: Record<string, unknown>; parameterCount: number }> {
    const profile = await this.request('GET', `${this.credentials.phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating`, undefined, timeoutMs);
    const templates = await this.request('GET', `${this.credentials.businessAccountId}/message_templates?name=${encodeURIComponent(this.credentials.templateName)}&limit=20`, undefined, timeoutMs);
    const rows = Array.isArray(templates['data']) ? templates['data'].filter(isRecord) : [];
    const template = rows.find((item) => item['name'] === this.credentials.templateName && item['language'] === this.credentials.languageCode);
    if (!template) throw new WhatsAppCloudError(422, `Meta 未找到模板 ${this.credentials.templateName} (${this.credentials.languageCode})`);
    if (String(template['status'] ?? '').toUpperCase() !== 'APPROVED') {
      throw new WhatsAppCloudError(422, `WhatsApp 模板状态为 ${String(template['status'] ?? '未知')}，尚未批准`);
    }
    const parameterCount = templateParameterCount(template);
    if (parameterCount !== this.credentials.templateParameterKeys.length) {
      throw new WhatsAppCloudError(422, `模板需要 ${parameterCount} 个正文参数，当前配置了 ${this.credentials.templateParameterKeys.length} 个`);
    }
    return { profile, template, parameterCount };
  }

  async sendTemplate(input: WhatsAppTemplateMessageInput, timeoutMs = 25_000): Promise<{ messageId: string; acceptedAt: string }> {
    const to = normalizeWhatsAppRecipient(input.to);
    const values: Record<WhatsAppTemplateParameterKey, string> = {
      po_number: requiredText(input.poNumber, 'poNumber', 200),
      supplier_name: requiredText(input.supplierName, 'supplierName', 300),
      message: requiredText(input.message, 'message', 4_096),
    };
    const parameters = this.credentials.templateParameterKeys.map((key) => ({ type: 'text', text: values[key] }));
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: this.credentials.templateName,
        language: { code: this.credentials.languageCode },
        ...(parameters.length ? { components: [{ type: 'body', parameters }] } : {}),
      },
      biz_opaque_callback_data: requiredText(input.idempotencyKey, 'idempotencyKey', 512),
    };
    const response = await this.request('POST', `${this.credentials.phoneNumberId}/messages`, payload, timeoutMs);
    const messages = Array.isArray(response['messages']) ? response['messages'].filter(isRecord) : [];
    const messageId = typeof messages[0]?.['id'] === 'string' ? messages[0]['id'].trim() : '';
    if (!messageId) throw new WhatsAppCloudError(502, 'Meta WhatsApp 响应缺少 message id');
    return { messageId, acceptedAt: new Date().toISOString() };
  }

  private async request(method: 'GET' | 'POST', path: string, body: Record<string, unknown> | undefined, timeoutMs: number): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, Math.min(60_000, timeoutMs)));
    try {
      const response = await this.fetchImpl(`https://graph.facebook.com/${this.credentials.apiVersion}/${path}`, {
        method,
        headers: { authorization: `Bearer ${this.credentials.accessToken}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
      const raw = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(raw || '{}') as unknown; } catch { parsed = {}; }
      const value = isRecord(parsed) ? parsed : {};
      if (!response.ok) {
        const error = isRecord(value['error']) ? value['error'] : {};
        const message = typeof error['message'] === 'string' ? error['message'].slice(0, 500) : `Meta WhatsApp HTTP ${response.status}`;
        const code = typeof error['code'] === 'number' || typeof error['code'] === 'string' ? ` code=${String(error['code'])}` : '';
        throw new WhatsAppCloudError(response.status, `Meta WhatsApp HTTP ${response.status}${code}: ${message}`);
      }
      return value;
    } catch (error) {
      if (error instanceof WhatsAppCloudError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw new WhatsAppCloudError(408, 'Meta WhatsApp 请求超时，投递结果不确定');
      throw error;
    } finally { clearTimeout(timer); }
  }
}

export class WhatsAppCloudError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'WhatsAppCloudError'; }
}

export function parseWhatsAppCredentials(value: Record<string, unknown>): WhatsAppCloudCredentials {
  const phoneNumberId = numericId(value['phoneNumberId'], 'phoneNumberId');
  const businessAccountId = numericId(value['businessAccountId'], 'businessAccountId');
  const accessToken = requiredText(value['accessToken'], 'accessToken', 4_096);
  const appSecret = requiredText(value['appSecret'], 'appSecret', 1_024);
  const verifyToken = requiredText(value['verifyToken'], 'verifyToken', 1_024);
  const apiVersion = String(value['apiVersion'] ?? 'v23.0').trim();
  if (!/^v\d{1,2}\.\d{1,2}$/.test(apiVersion)) throw new WhatsAppCloudError(422, 'apiVersion 必须类似 v23.0');
  const templateName = requiredText(value['templateName'], 'templateName', 512);
  if (!/^[a-z0-9_]+$/.test(templateName)) throw new WhatsAppCloudError(422, 'templateName 只能包含小写字母、数字和下划线');
  const languageCode = requiredText(value['languageCode'] ?? 'zh_CN', 'languageCode', 20);
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(languageCode)) throw new WhatsAppCloudError(422, 'languageCode 格式无效');
  const rawKeys = Array.isArray(value['templateParameterKeys'])
    ? value['templateParameterKeys'].map(String)
    : String(value['templateParameterKeys'] ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const allowed = new Set<WhatsAppTemplateParameterKey>(['po_number', 'supplier_name', 'message']);
  if (rawKeys.some((key) => !allowed.has(key as WhatsAppTemplateParameterKey))) throw new WhatsAppCloudError(422, 'templateParameterKeys 只支持 po_number,supplier_name,message');
  if (new Set(rawKeys).size !== rawKeys.length) throw new WhatsAppCloudError(422, 'templateParameterKeys 不得重复');
  return { phoneNumberId, businessAccountId, accessToken, appSecret, verifyToken, apiVersion, templateName, languageCode, templateParameterKeys: rawKeys as WhatsAppTemplateParameterKey[] };
}

export function normalizeWhatsAppRecipient(value: string): string {
  const normalized = value.trim().replace(/[\s()+.-]/g, '');
  if (!/^\d{8,15}$/.test(normalized)) throw new WhatsAppCloudError(422, 'WhatsApp 收件号码必须是带国家码的 8-15 位数字');
  return normalized;
}

function templateParameterCount(template: Record<string, unknown>): number {
  const components = Array.isArray(template['components']) ? template['components'].filter(isRecord) : [];
  const body = components.find((item) => String(item['type'] ?? '').toUpperCase() === 'BODY');
  const text = typeof body?.['text'] === 'string' ? body['text'] : '';
  let max = 0;
  for (const match of text.matchAll(/\{\{(\d+)\}\}/g)) max = Math.max(max, Number(match[1]));
  return max;
}

function numericId(value: unknown, field: string): string {
  const text = requiredText(value, field, 100);
  if (!/^\d+$/.test(text)) throw new WhatsAppCloudError(422, `${field} 必须是数字 ID`);
  return text;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new WhatsAppCloudError(422, `${field} 必填且不能超过 ${max} 字符`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
