import { sendMail, type SendMailInput, type SendMailResult } from './smtp.js';
import type { ConnectorDef, ConnectorStatus } from './index.js';

/**
 * 网易 163 邮箱连接器 —— 真实 SMTP 发信（smtp.163.com:465 SSL）。
 * 凭证来自环境变量 NETEASE_MAIL_USER / NETEASE_MAIL_PASS（授权码），不硬编码。
 */
export class NetEaseMailConnector implements ConnectorDef {
  id = 'netease-mail';
  name = '网易邮箱';
  category = 'Email';
  description = '网易 163 邮箱 SMTP 真实发信（smtp.163.com:465）';

  private current: ConnectorStatus = 'disconnected';
  private user: string;
  private pass: string;

  constructor(opts?: { user?: string; pass?: string }) {
    this.user = opts?.user ?? process.env['NETEASE_MAIL_USER'] ?? '';
    this.pass = opts?.pass ?? process.env['NETEASE_MAIL_PASS'] ?? '';
  }

  get configured(): boolean {
    return Boolean(this.user && this.pass);
  }

  status(): ConnectorStatus {
    return this.current;
  }

  async connect(): Promise<{ ok: boolean; message?: string }> {
    if (!this.configured) {
      return { ok: false, message: '未配置邮箱地址/授权码（NETEASE_MAIL_USER / NETEASE_MAIL_PASS）' };
    }
    this.current = 'connecting';
    const r = await sendMail('smtp.163.com', 465, this.user, this.pass, {
      to: this.user,
      subject: 'readywork 连接测试',
      body: '这是一封来自 AI Workforce OS 的 SMTP 连接测试邮件。收到即表示连接器已打通。',
    });
    if (r.ok) {
      this.current = 'connected';
      return { ok: true, message: `SMTP 连接成功，测试邮件已发送至 ${this.user}` };
    }
    this.current = 'error';
    return r;
  }

  async disconnect(): Promise<{ ok: boolean }> {
    this.current = 'disconnected';
    return { ok: true };
  }

  async send(msg: SendMailInput): Promise<SendMailResult> {
    if (!this.configured) return { ok: false, message: '未配置凭证' };
    return sendMail('smtp.163.com', 465, this.user, this.pass, msg);
  }
}
