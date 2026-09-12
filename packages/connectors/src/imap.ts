import { connect as tlsConnect } from 'node:tls';
import { createConnection as netConnect } from 'node:net';

/**
 * 极简 IMAP 客户端（零依赖）。
 * 支持 LOGIN / SELECT / UID SEARCH / UID FETCH / UID STORE，用于轮询供应商回信。
 * 默认走 TLS（网易 imap.163.com:993）；secure:false 走明文（本地测试邮箱）。
 */

export interface ImapConfig {
  host: string; // imap.163.com
  port: number; // 993
  user: string;
  pass: string; // 授权码
  mailbox?: string; // INBOX
  timeoutMs?: number;
  secure?: boolean; // 默认 true（TLS）
}

export interface InboundEmail {
  id: string; // UID
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
  messageId?: string;
  inReplyTo?: string;
  references?: readonly string[];
  attachments?: readonly InboundEmailAttachment[];
}

export interface InboundEmailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string;
}

export interface FetchUnseenOptions {
  /** Provider-safe upper bound; newest UIDs are processed first. */
  limit?: number;
  /** UIDs under durable business backoff that must not be fetched this run. */
  excludeUids?: ReadonlySet<string>;
  /**
   * Rejected UIDs selected by an operator for re-evaluation. Priority changes
   * ordering only; the message must still be UNSEEN and stays under the limit.
   */
  priorityUids?: ReadonlySet<string>;
}

export class MimeMessageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MimeMessageLimitError';
  }
}

const MAX_MIME_DEPTH = 8;
const MAX_ATTACHMENTS = 12;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;

interface RawSocket {
  setTimeout(ms: number): void;
  on(ev: string, cb: (arg: unknown) => void): unknown;
  once(ev: string, cb: (arg: unknown) => void): unknown;
  off(ev: string, cb: (arg: unknown) => void): unknown;
  write(data: string | Buffer): void;
  destroy(): void;
}

export class ImapClient {
  private socket!: RawSocket;
  private buf: Buffer = Buffer.alloc(0);
  private tagSeq = 0;

  private constructor(private config: ImapConfig) {}

  static async connect(config: ImapConfig): Promise<ImapClient> {
    const client = new ImapClient(config);
    await client.open();
    return client;
  }

  private async open(): Promise<void> {
    this.socket = this.config.secure === false
      ? (netConnect({ host: this.config.host, port: this.config.port }) as unknown as RawSocket)
      : (tlsConnect({ host: this.config.host, port: this.config.port, servername: this.config.host }) as unknown as RawSocket);
    this.socket.setTimeout(this.config.timeoutMs ?? 15_000);
    this.socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)]);
    });
    this.socket.on('timeout', () => this.socket.destroy());
    await this.waitData();
    // 读 greeting
    const greeting = await this.readLine();
    if (!greeting.startsWith('* OK')) throw new Error(`IMAP 握手失败: ${greeting}`);
    // Coremail（网易）要求在认证前先通过 RFC 2971 ID 声明客户端，否则 LOGIN 会被判定为不安全登录。
    await this.command(`ID ("name" "Readywork" "version" "1.0.0" "vendor" "Readywork" "support-email" "support@readywork.ai")`);
    await this.command(`LOGIN ${this.config.user} ${this.config.pass}`);
    await this.command(`SELECT ${this.config.mailbox ?? 'INBOX'}`);
  }

  private async waitData(): Promise<void> {
    // 始终等待新数据到达（readBytes/readCrlfLine 在缓冲不足时会循环调用这里；
    // 若这里因"缓冲非空"提前返回，会造成忙等微任务循环、永远等不到下一次 data 事件）
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.socket.off('data', onData);
        this.socket.off('error', onError);
        this.socket.off('close', onClose);
        this.socket.off('timeout', onTimeout);
      };
      const onData = () => { cleanup(); resolve(); };
      const onError = (error: unknown) => { cleanup(); reject(error instanceof Error ? error : new Error('IMAP 连接错误')); };
      const onClose = () => { cleanup(); reject(new Error('IMAP 连接已关闭')); };
      const onTimeout = () => { cleanup(); reject(new Error('IMAP 请求超时')); };
      this.socket.once('data', onData);
      this.socket.once('error', onError);
      this.socket.once('close', onClose);
      this.socket.once('timeout', onTimeout);
    });
  }

  /** 读取到 \r\n 或 \n 为止（不处理字面量），返回 UTF-8 解码后的行 */
  private async readCrlfLine(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i >= 0) {
        const line = this.buf.subarray(0, i).toString('utf8');
        this.buf = this.buf.subarray(i + 2);
        return line;
      }
      const j = this.buf.indexOf('\n');
      if (j >= 0) {
        const line = this.buf.subarray(0, j).toString('utf8');
        this.buf = this.buf.subarray(j + 1);
        return line;
      }
      await this.waitData();
    }
  }

  /** 读取 n 个字节（IMAP 字面量长度按字节计） */
  private async readBytes(n: number): Promise<Buffer> {
    for (;;) {
      if (this.buf.length >= n) {
        const data = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        return Buffer.from(data);
      }
      await this.waitData();
    }
  }

  /** 读取一行，透明处理 `{n}` 字面量（按字节读取并把内容内联进该行） */
  private async readLine(): Promise<string> {
    let line = await this.readCrlfLine();
    for (;;) {
      const m = line.match(/\{(\d+)\}$/);
      if (!m) return line;
      const n = Number(m[1]);
      const data = await this.readBytes(n);
      const rest = await this.readCrlfLine();
      line = line.slice(0, line.length - m[0].length) + data.toString('utf8') + rest;
    }
  }

  /** 发送命令并读到 tagged 完成，返回该 tagged 状态行 */
  private async command(cmd: string): Promise<string> {
    const tag = `A${String(++this.tagSeq).padStart(3, '0')}`;
    this.socket.write(`${tag} ${cmd}\r\n`);
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
          const commandLabel = cmd.startsWith('LOGIN ') ? 'LOGIN ***' : cmd;
          throw new Error(`IMAP ${commandLabel} 失败: ${line}`);
        }
        return line;
      }
    }
  }

  /** 执行 UID 命令，返回所有未标记（untagged）响应行 */
  private async uidCommand(cmd: string): Promise<string[]> {
    const tag = `A${String(++this.tagSeq).padStart(3, '0')}`;
    this.socket.write(`${tag} UID ${cmd}\r\n`);
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      if (line.startsWith(`${tag} `)) {
        if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) {
          throw new Error(`IMAP UID ${cmd} 失败: ${line}`);
        }
        return lines;
      }
      if (line.startsWith('* ')) lines.push(line);
    }
  }

  /** 拉取所有未读邮件（不含正文，仅信封头） */
  async fetchUnseenUids(): Promise<string[]> {
    const lines = await this.uidCommand('SEARCH UNSEEN');
    const uids: string[] = [];
    for (const line of lines) {
      const m = line.match(/^\* SEARCH (.*)$/);
      if (m) uids.push(...m[1]!.trim().split(/\s+/).filter(Boolean));
    }
    return uids;
  }

  /** 拉取某 UID 的完整原文并解析为邮件（按字节读取 BODY[] 字面量） */
  async fetchEmail(uid: string): Promise<InboundEmail> {
    const tag = `A${String(++this.tagSeq).padStart(3, '0')}`;
    this.socket.write(`${tag} UID FETCH ${uid} (UID BODY.PEEK[])\r\n`);
    let raw = '';
    for (;;) {
      const line = await this.readCrlfLine();
      if (line.startsWith(`${tag} `)) {
        if (line.startsWith(`${tag} NO`) || line.startsWith(`${tag} BAD`)) throw new Error(`IMAP FETCH 失败: ${line}`);
        break;
      }
      const m = line.match(/BODY\[\]\s*\{(\d+)\}/);
      if (m) {
        const n = Number(m[1]);
        raw = (await this.readBytes(n)).toString('utf8');
        await this.readCrlfLine(); // 读完字面量后的行尾 `)`
      }
    }
    const parsed = parseRawMessage(raw);
    return { id: uid, ...parsed };
  }

  /** 拉取所有未读邮件（完整解析） */
  async fetchUnseen(options: FetchUnseenOptions = {}): Promise<InboundEmail[]> {
    const limit = options.limit === undefined ? 50 : Math.max(1, Math.min(100, Math.floor(options.limit)));
    const available = (await this.fetchUnseenUids())
      .filter((uid) => !options.excludeUids?.has(uid));
    const priority = options.priorityUids
      ? available.filter((uid) => options.priorityUids!.has(uid)).reverse()
      : [];
    const prioritySet = new Set(priority);
    const remaining = available
      .filter((uid) => !prioritySet.has(uid))
      .slice(-Math.max(0, limit - priority.length))
      .reverse();
    const uids = [...priority.slice(0, limit), ...remaining].slice(0, limit);
    const out: InboundEmail[] = [];
    for (const uid of uids) out.push(await this.fetchEmail(uid));
    return out;
  }

  /** 标记为已读（幂等） */
  async markSeen(uid: string): Promise<void> {
    await this.uidCommand(`STORE ${uid} +FLAGS (\\Seen)`);
  }

  /**
   * Deterministically closes the underlying socket without issuing another
   * network command. Poll workers use this on timeout/failure so a poisoned
   * long-lived IMAP connection cannot leave the next run pending forever.
   */
  close(): void {
    this.socket?.destroy();
  }

  async logout(): Promise<void> {
    try {
      await this.command('LOGOUT');
    } catch {
      /* ignore */
    }
    this.close();
  }
}

export function parseRawMessage(raw: string): Omit<InboundEmail, 'id'> {
  const split = splitHeadersAndBody(raw);
  const headerText = split.headers;
  const bodyRaw = split.body;
  const headers = parseHeaders(headerText);
  const from = decodeMime(headers.get('from') ?? '');
  const subject = decodeMime(headers.get('subject') ?? '');
  const date = headers.get('date') ?? new Date().toISOString();
  const messageId = normalizeMessageIdHeader(headers.get('message-id'));
  const inReplyTo = normalizeMessageIdHeader(headers.get('in-reply-to'));
  const references = (headers.get('references')?.match(/<[^<>\s]+@[^<>\s]+>/g) ?? [])
    .map((item) => normalizeMessageIdHeader(item))
    .filter((item): item is string => Boolean(item));
  const decoded = decodeMimeEntity(headers, bodyRaw, 0);
  if (decoded.attachments.length > MAX_ATTACHMENTS) {
    throw new MimeMessageLimitError(`邮件附件数超过 ${MAX_ATTACHMENTS} 个限制`);
  }
  const totalAttachmentBytes = decoded.attachments.reduce((sum, item) => sum + item.content.byteLength, 0);
  if (totalAttachmentBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new MimeMessageLimitError(`邮件附件总大小超过 ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024} MB 限制`);
  }
  return {
    from,
    subject,
    body: decoded.body,
    receivedAt: date,
    ...(messageId ? { messageId } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references.length ? { references } : {}),
    ...(decoded.attachments.length ? { attachments: decoded.attachments } : {}),
  };
}

function splitHeadersAndBody(raw: string): { headers: string; body: string } {
  const match = /\r?\n\r?\n/.exec(raw);
  if (!match || match.index === undefined) return { headers: raw, body: '' };
  return { headers: raw.slice(0, match.index), body: raw.slice(match.index + match[0].length) };
}

function normalizeMessageIdHeader(value: string | undefined): string | undefined {
  if (!value || /[\r\n]/.test(value)) return undefined;
  const match = /<([^<>\s]+@[^<>\s]+)>/.exec(value.trim());
  return match ? `<${match[1]}>` : undefined;
}

function parseHeaders(headerText: string): Map<string, string> {
  const headers = new Map<string, string>();
  const unfolded = headerText.replace(/\r?\n[\t ]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  return headers;
}

function decodeMimeEntity(
  headers: Map<string, string>,
  raw: string,
  depth: number,
): { body: string; attachments: InboundEmailAttachment[] } {
  if (depth > MAX_MIME_DEPTH) throw new MimeMessageLimitError(`MIME 嵌套层级超过 ${MAX_MIME_DEPTH} 层限制`);
  const contentType = (headers.get('content-type') ?? 'text/plain').toLowerCase();
  const declaredBoundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.slice(1).find(Boolean);
  // Some providers omit or mangle the top-level Content-Type parameters while
  // still emitting a standards-shaped boundary in the body. Infer it only
  // when it is immediately followed by a MIME Content-Type header.
  const inferredBoundary = /(?:^|\r?\n)--([^\r\n]+)\r?\nContent-Type:/i.exec(raw)?.[1];
  const boundary = declaredBoundary ?? inferredBoundary;
  if ((contentType.startsWith('multipart/') || inferredBoundary !== undefined) && boundary) {
    const parts = raw.split(`--${boundary}`)
      .map((part) => part.replace(/^\r?\n/, '').replace(/\r?\n$/, ''))
      .filter((part) => part && part !== '--' && !part.startsWith('--'));
    let plainBody = '';
    let htmlFallback = '';
    const attachments: InboundEmailAttachment[] = [];
    for (const part of parts) {
      const split = splitHeadersAndBody(part);
      if (!split.body && split.headers === part) continue;
      const partHeaders = parseHeaders(split.headers);
      const decoded = decodeMimeEntity(partHeaders, split.body, depth + 1);
      const partType = (partHeaders.get('content-type') ?? 'text/plain').toLowerCase();
      attachments.push(...decoded.attachments);
      if (partType.startsWith('text/plain') && decoded.body.trim() && !plainBody) plainBody = decoded.body.trim();
      if (partType.startsWith('text/html') && decoded.body.trim() && !htmlFallback) htmlFallback = stripHtml(decoded.body);
    }
    return { body: plainBody || htmlFallback.trim(), attachments };
  }
  const disposition = headers.get('content-disposition') ?? '';
  const filename = mimeParameter(disposition, 'filename') ?? mimeParameter(headers.get('content-type') ?? '', 'name');
  const contentId = normalizeContentId(headers.get('content-id'));
  const decodedBytes = decodeTransferBytes(headers, raw);
  const mediaType = contentType.split(';', 1)[0]!.trim() || 'application/octet-stream';
  const explicitAttachment = /^\s*attachment\b/i.test(disposition);
  const filenameAttachment = Boolean(filename)
    && !mediaType.startsWith('text/')
    && !(mediaType.startsWith('image/') && contentId && /^\s*inline\b/i.test(disposition));
  if (explicitAttachment || filenameAttachment) {
    if (decodedBytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new MimeMessageLimitError(`单个邮件附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB 限制`);
    }
    const safeName = sanitizeAttachmentFilename(filename ?? 'attachment.bin');
    return {
      body: '',
      attachments: [{ filename: safeName, contentType: mediaType, content: decodedBytes, ...(contentId ? { contentId } : {}) }],
    };
  }
  const decodedText = decodedBytes.toString('utf8');
  return { body: mediaType === 'text/html' ? stripHtml(decodedText) : decodedText, attachments: [] };
}

function decodeTransferBytes(headers: Map<string, string>, raw: string): Buffer {
  const transferEncoding = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
  if (transferEncoding === 'base64') return Buffer.from(raw.replace(/\s/g, ''), 'base64');
  if (transferEncoding === 'quoted-printable') return decodeQuotedPrintableBytes(raw);
  return Buffer.from(raw, 'utf8');
}

function decodeQuotedPrintable(raw: string): string {
  return decodeQuotedPrintableBytes(raw).toString('utf8');
}

function decodeQuotedPrintableBytes(raw: string): Buffer {
  const input = raw.replace(/=\r?\n/g, '');
  const chunks: Buffer[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const hex = input.slice(index + 1, index + 3);
    if (input[index] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      chunks.push(Buffer.from([parseInt(hex, 16)]));
      index += 2;
    } else {
      chunks.push(Buffer.from(input[index]!, 'utf8'));
    }
  }
  return Buffer.concat(chunks);
}

function mimeParameter(value: string, name: string): string | undefined {
  const extended = new RegExp(`${name}\\*\\s*=\\s*(?:UTF-8''|)(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(value);
  const ordinary = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(value);
  const raw = extended?.slice(1).find((item) => item !== undefined) ?? ordinary?.slice(1).find((item) => item !== undefined);
  if (!raw) return undefined;
  try { return decodeMime(decodeURIComponent(raw)); } catch { return decodeMime(raw); }
}

function sanitizeAttachmentFilename(value: string): string {
  if (/[\r\n\u0000]/.test(value)) throw new MimeMessageLimitError('附件文件名含有非法控制字符');
  const leaf = value.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  const safe = leaf.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
  if (!safe || safe === '.' || safe === '..') throw new MimeMessageLimitError('附件文件名无效');
  return safe;
}

function normalizeContentId(value: string | undefined): string | undefined {
  if (!value || /[\r\n]/.test(value)) return undefined;
  const normalized = value.trim().replace(/^<|>$/g, '');
  return normalized || undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/** 解析 MIME 编码字（=?UTF-8?B?…?= / =?UTF-8?Q?…?=） */
function decodeMime(s: string): string {
  return s.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _cs: string, enc: string, data: string) => {
    try {
      if (enc.toLowerCase() === 'b') return Buffer.from(data, 'base64').toString('utf8');
      return data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_s, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    } catch {
      return data;
    }
  });
}
