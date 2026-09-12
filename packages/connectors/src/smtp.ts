import { connect, type TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';

/**
 * 极简 SMTP 客户端（零依赖，node:tls）。
 * 支持 AUTH LOGIN + 发信，用于网易 163 邮箱等 SMTP 服务。
 */

export interface SendMailInput {
  to: string;
  /** Supplier-visible display name. SMTP envelope sender remains the authenticated mailbox. */
  fromName?: string;
  subject: string;
  body: string;
  /** RFC 5322 Message-ID. The SMTP sender creates one when omitted. */
  messageId?: string;
  /** RFC 5322 thread headers used when replying from Readywork. */
  inReplyTo?: string;
  references?: readonly string[];
  date?: string;
  /** MIME 附件；内容直接以二进制传入，不经由 outbox/API 序列化。 */
  attachments?: Array<{
    filename: string;
    contentType: string;
    content: Buffer | Uint8Array;
  }>;
}

export interface SendMailResult {
  ok: boolean;
  message: string;
  /** Exact Message-ID written into the MIME message when SMTP accepted it. */
  messageId?: string;
  /** Exact time when the SMTP server returned the final 250 acceptance. */
  acceptedAt?: string;
  /** Whether any MIME DATA bytes may already have reached the provider. */
  dispatchStage?: 'before_dispatch' | 'after_dispatch';
  /** Only meaningful before dispatch. Post-dispatch uncertainty is never retried. */
  retryable?: boolean;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

/** MIME 的 base64 每行最多 76 个字符（RFC 2045）。 */
function b64Lines(content: string | Uint8Array): string {
  const encoded = Buffer.from(content).toString('base64');
  return encoded.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function safeContentType(contentType: string): string {
  const value = contentType.trim();
  // 不接受参数或控制字符，避免附件元数据写入 MIME 头时发生头注入。
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)
    ? value
    : 'application/octet-stream';
}

function safeFilename(filename: string): { fallback: string; encoded: string } {
  const normalized = filename.replace(/[\r\n]/g, ' ').trim() || 'attachment';
  // filename= 保留一个兼容旧客户端的纯 ASCII 版本；filename*= 使用 RFC 5987 的 UTF-8 百分号编码。
  const fallback = normalized.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(normalized).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return { fallback, encoded };
}

/**
 * 组装 DATA 阶段的 MIME 内容。导出仅用于连接器级测试，未从包入口导出。
 */
export function buildMailPayload(user: string, mail: SendMailInput): string {
  const from = mail.fromName
    ? `=?UTF-8?B?${b64(safeHeaderValue(mail.fromName, 'From name'))}?= <${user}>`
    : user;
  const headers = [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: =?UTF-8?B?${b64(mail.subject)}?=`,
    ...(mail.date ? [`Date: ${safeHeaderValue(mail.date, 'Date')}`] : []),
    ...(mail.messageId ? [`Message-ID: ${normalizeMessageId(mail.messageId)}`] : []),
    ...(mail.inReplyTo ? [`In-Reply-To: ${normalizeMessageId(mail.inReplyTo)}`] : []),
    ...(mail.references?.length ? [`References: ${mail.references.map(normalizeMessageId).join(' ')}`] : []),
    'MIME-Version: 1.0',
  ];

  if (!mail.attachments?.length) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64Lines(mail.body),
    ].join('\r\n');
  }

  // 由随机边界分隔各部分；所有内容部分是 base64，因此不会意外包含 "--boundary" 分隔符。
  const boundary = `=_readywork_${randomBytes(18).toString('hex')}`;
  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64Lines(mail.body),
  ];

  for (const attachment of mail.attachments) {
    const filename = safeFilename(attachment.filename);
    parts.push(
      `--${boundary}`,
      `Content-Type: ${safeContentType(attachment.contentType)}; name="${filename.fallback}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${filename.fallback}"; filename*=UTF-8\'\'${filename.encoded}`,
      '',
      b64Lines(attachment.content),
    );
  }
  parts.push(`--${boundary}--`);
  return parts.join('\r\n');
}

class SmtpClient {
  private buf = '';
  private lines: string[] = [];
  private waiters: ((l: string) => void)[] = [];

  constructor(private socket: TLSSocket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        const w = this.waiters.shift();
        if (w) w(line);
        else this.lines.push(line);
      }
    });
  }

  private readLine(timeoutMs = 15_000): Promise<string> {
    if (this.lines.length) return Promise.resolve(this.lines.shift()!);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('SMTP 读超时')), timeoutMs);
      this.waiters.push((l) => {
        clearTimeout(t);
        resolve(l);
      });
    });
  }

  private code(line: string): number {
    const n = parseInt(line.slice(0, 3), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  write(cmd: string): void {
    this.socket.write(cmd + '\r\n');
  }

  writeRaw(data: string): void {
    this.socket.write(data);
  }

  async expect(expected: number): Promise<string> {
    const line = await this.readLine();
    const c = this.code(line);
    if (c !== expected) throw new Error(`SMTP 期望 ${expected}，收到：${line}`);
    return line;
  }

  /** 读取到 "code + 空格" 结尾（多行响应以 "code-" 续行） */
  async expectMulti(expected: number): Promise<string> {
    let full = '';
    for (;;) {
      const line = await this.readLine();
      full += line + '\n';
      const c = this.code(line);
      if (c !== 0 && line.length >= 4 && line[3] === ' ') {
        if (c !== expected) throw new Error(`SMTP 期望 ${expected}，收到：${line}`);
        return full;
      }
    }
  }

  close(): void {
    this.socket.end();
  }
}

export function sendMail(
  host: string,
  port: number,
  user: string,
  pass: string,
  mail: SendMailInput,
): Promise<SendMailResult> {
  return new Promise((resolve) => {
    let settled = false;
    let dataStarted = false;
    const messageId = mail.messageId ? normalizeMessageId(mail.messageId) : createMessageId(user);
    const date = mail.date ?? new Date().toUTCString();
    const socket = connect({ host, port, servername: host }, () => void run());
    const failure = (message: string): SendMailResult => ({ ok: false, message, ...classifySmtpFailure(message, dataStarted) });
    const timer = setTimeout(() => finish(failure('SMTP 整体超时（30s）')), 30_000);
    socket.on('error', (e) => finish(failure(`SMTP 连接错误：${e.message}`)));
    const finish = (r: SendMailResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };

    const run = async (): Promise<void> => {
      const c = new SmtpClient(socket);
      try {
        await c.expectMulti(220);
        c.write('EHLO readywork');
        await c.expectMulti(250);
        c.write('AUTH LOGIN');
        await c.expect(334);
        c.write(b64(user));
        await c.expect(334);
        c.write(b64(pass));
        await c.expect(235);
        c.write(`MAIL FROM:<${user}>`);
        await c.expect(250);
        c.write(`RCPT TO:<${mail.to}>`);
        await c.expect(250);
        c.write('DATA');
        await c.expect(354);
        const payload = buildMailPayload(user, { ...mail, messageId, date });
        dataStarted = true;
        c.writeRaw(payload + '\r\n.\r\n');
        await c.expect(250);
        const acceptedAt = new Date().toISOString();
        c.write('QUIT');
        c.close();
        finish({ ok: true, message: `邮件已发送至 ${mail.to}`, messageId, acceptedAt });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        finish(failure(message));
      }
    };
  });
}

export function classifySmtpFailure(
  message: string,
  dataStarted: boolean,
): { dispatchStage: 'before_dispatch' | 'after_dispatch'; retryable: boolean } {
  if (dataStarted) return { dispatchStage: 'after_dispatch', retryable: false };
  const responseCode = Number(/收到：\s*(\d{3})/u.exec(message)?.[1] ?? 0);
  if (responseCode >= 500 && responseCode < 600) return { dispatchStage: 'before_dispatch', retryable: false };
  if (/邮件头无效|Message-ID 格式无效|收件人地址无效/u.test(message)) {
    return { dispatchStage: 'before_dispatch', retryable: false };
  }
  return { dispatchStage: 'before_dispatch', retryable: true };
}

function safeHeaderValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error(`${label} 邮件头无效`);
  return normalized;
}

function normalizeMessageId(value: string): string {
  const normalized = safeHeaderValue(value, 'Message-ID').replace(/^<|>$/g, '');
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(normalized)) throw new Error('Message-ID 格式无效');
  return `<${normalized}>`;
}

function createMessageId(user: string): string {
  const domainCandidate = user.trim().split('@')[1]?.toLowerCase() ?? '';
  const domain = /^[a-z0-9.-]+$/.test(domainCandidate) ? domainCandidate : 'readywork.local';
  return `<readywork.${Date.now()}.${randomBytes(18).toString('hex')}@${domain}>`;
}
