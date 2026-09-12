import { createHash } from 'node:crypto';
import type { AdapterHealth, AdapterSendResult, AdapterPollInput, MessagingCapability, MessageDeliveryRequest, MessagingAdapter } from '@readywork/messaging';
import type { SendMailInput, SendMailResult } from '@readywork/connectors';
import { ImapClient, pollInboundMail, type MailRouteHandler } from '@readywork/connectors';
import { redactSensitive } from '../http-errors.js';

export type EmailSendPortInput = SendMailInput;
export type EmailSendPortResult = SendMailResult & {
  readonly acceptedAt?: string;
  readonly dispatchStage?: 'before_dispatch' | 'after_dispatch';
  readonly retryable?: boolean;
};
export type EmailSendPort = (input: EmailSendPortInput) => Promise<EmailSendPortResult>;

export interface EmailMessagingAdapterOptions {
  readonly poll?: (input: AdapterPollInput, signal: AbortSignal) => Promise<{handledCount:number}>;
  readonly health?: () => Promise<AdapterHealth>;
  readonly now?: () => string;
}

export class EmailMessagingAdapter implements MessagingAdapter {
  readonly channel = 'email' as const;
  readonly capabilities: readonly MessagingCapability[];
  private readonly now: () => string;

  constructor(
    readonly id: string,
    readonly provider: string,
    private readonly sendMail: EmailSendPort,
    private readonly options: EmailMessagingAdapterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.capabilities = options.poll ? ['receive','threads'] : ['send_text','send_attachments','threads'];
  }

  async health(): Promise<AdapterHealth> {
    return this.options.health ? this.options.health() : { ok: false, message:'尚无最近协议健康观测' };
  }

  async poll(input: AdapterPollInput, signal: AbortSignal): Promise<{handledCount:number}> {
    if (!this.options.poll) throw new Error('邮件适配器未配置接收协议');
    return this.options.poll(input,signal);
  }

  async send(request: MessageDeliveryRequest): Promise<AdapterSendResult> {
    if (request.channel !== 'email') return { kind: 'failed_before_dispatch', error: 'Email 适配器只接受 email 渠道请求' };
    if (request.recipients.length !== 1 || !request.recipients[0]?.address.trim()) {
      return { kind: 'failed_before_dispatch', error: 'Email 适配器要求一个有效收件人' };
    }
    const result = await this.sendMail({
      to: request.recipients[0].address,
      ...(request.sender?.displayName ? { fromName: request.sender.displayName } : {}),
      subject: request.subject ?? '',
      body: request.text,
      messageId: deterministicMessageId(request),
      ...(request.thread?.inReplyTo ? { inReplyTo: request.thread.inReplyTo } : {}),
      ...(request.thread?.references?.length ? { references: [...request.thread.references] } : {}),
      ...(request.attachments.length > 0 ? {
        attachments: request.attachments.map((attachment) => ({
          filename: attachment.name,
          contentType: attachment.contentType,
          content: attachment.content,
        })),
      } : {}),
    });
    if (result.ok) {
      if (!result.messageId) {
        return {
          kind: 'unknown_after_dispatch',
          error: 'SMTP 已返回成功但缺少 Message-ID，投递结果需要人工核对',
        };
      }
      return {
        kind: 'accepted',
        providerMessageId: result.messageId,
        acceptedAt: result.acceptedAt ?? this.now(),
      };
    }

    const error = redactSensitive(result.message, 500) || 'SMTP 投递失败';
    if (result.dispatchStage === 'after_dispatch') return { kind: 'unknown_after_dispatch', error };
    return result.retryable === false
      ? { kind: 'failed_before_dispatch', error }
      : { kind: 'retryable_before_dispatch', error };
  }
}

function deterministicMessageId(request: MessageDeliveryRequest): string {
  const digest = createHash('sha256')
    .update(`${request.tenantId}\0${request.adapterId}\0${request.idempotencyKey}`)
    .digest('hex');
  return `<readywork.${digest}@readywork.local>`;
}

/** The protocol boundary owns connect, bounded fetch and connection cancellation. */
export function createImapReceivePort(
  resolveConfiguration: () => Parameters<typeof ImapClient.connect>[0] | undefined,
  handler: MailRouteHandler,
): NonNullable<EmailMessagingAdapterOptions['poll']> {
  return async (input,signal) => {
    const configuration=resolveConfiguration();
    if (!configuration) throw new Error('IMAP 尚未配置');
    const client=await ImapClient.connect(configuration);
    const close=()=>client.close();
    signal.addEventListener('abort',close,{once:true});
    try {
      signal.throwIfAborted();
      const handledCount=await pollInboundMail(client,async(email,poNumber)=>{
        if (signal.aborted) return false;
        return handler(email,poNumber);
      },{limit:20,...(input.excludeUids?{excludeUids:input.excludeUids}:{}),...(input.priorityUids?{priorityUids:input.priorityUids}:{})});
      return {handledCount};
    } finally {signal.removeEventListener('abort',close);close();}
  };
}
