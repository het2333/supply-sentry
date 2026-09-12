import type { FetchUnseenOptions, ImapClient, InboundEmail } from './imap.js';

/**
 * 收件路由：把供应商回信按「采购单号」路由到等待中的任务。
 * 配合 ImapClient 使用，凑成「真收信 → 路由 → 触发 workflow 事件」闭环。
 */

/** 从邮件主题/正文提取采购单号（支持 Odoo P00011 与 readywork PO-1001/po:1001 两种格式） */
export function extractPoNumber(subject: string, body: string): string | null {
  const text = `${subject}\n${body}`;
  // Odoo 单号：P + 至少 4 位数字（P00011）
  let m = text.match(/\bP\d{4,}\b/);
  if (m) return m[0];
  // readywork 单号：PO/po + 分隔符（- : ： 或空）+ 数字
  m = text.match(/\b[Pp][Oo][-:：]?\s*\d{2,}\b/);
  if (m) return m[0].replace(/\s/g, '');
  return null;
}

export interface MailRouteHandler {
  /** Return false to leave an unrelated/unresolved message unread. */
  (email: InboundEmail, poNumber: string | null): Promise<boolean | void>;
}

/** 轮询一次收件箱：逐封处理未读邮件，路由后标记已读（幂等）。返回已处理的邮件数。 */
export async function pollInboundMail(
  imap: ImapClient,
  handler: MailRouteHandler,
  options: FetchUnseenOptions = {},
): Promise<number> {
  const emails = await imap.fetchUnseen(options);
  let handled = 0;
  for (const email of emails) {
    const poNumber = extractPoNumber(email.subject, email.body);
    const accepted = await handler(email, poNumber);
    if (accepted !== false) {
      handled += 1;
      // Mark seen only after durable handling succeeds. Crashes before this
      // point are safe because the procurement store deduplicates UID/Message-ID.
      await imap.markSeen(email.id);
    }
  }
  return handled;
}
