import type { InboundEmail, MailRouteHandler } from '@readywork/connectors';
import type { InboundMessageEnvelope, MessageAttachmentPayload } from '@readywork/messaging';
import { normalizeInboundEmailEnvelope } from './procurement-bridge.js';

interface DurableInboundRuntime {
  ingest(
    envelope: InboundMessageEnvelope,
    attachments?: readonly MessageAttachmentPayload[],
  ): Promise<{ inboundId: string; replayed: boolean }>;
}

export interface DurableInboundMailHandlerOptions {
  readonly runtime: DurableInboundRuntime;
  readonly tenantId: string;
  readonly adapterId: string;
  readonly provider: string;
  readonly mailbox: string;
  readonly onPersisted?: (result: { inboundId: string; replayed: boolean }) => void;
}

/**
 * IMAP 确认止于持久化收件箱边界。采购与 AI 处理由持有独立租约的
 * 重放工作器执行，不占用邮件协议超时预算。
 */
export function createDurableInboundMailHandler(options: DurableInboundMailHandlerOptions): MailRouteHandler {
  return async (email: InboundEmail) => {
    const envelope=normalizeInboundEmailEnvelope({
      tenantId:options.tenantId,
      adapterId:options.adapterId,
      provider:options.provider,
      mailbox:options.mailbox,
      email,
    });
    const attachments=envelope.attachments.map((descriptor,index)=>{
      const source=email.attachments?.[index];
      if (!source) throw new Error('入站附件字节缺失，禁止确认 IMAP 收件');
      return {...descriptor,content:Buffer.from(source.content)};
    });
    const result=await options.runtime.ingest(envelope,attachments);
    options.onPersisted?.(result);
    return true;
  };
}
