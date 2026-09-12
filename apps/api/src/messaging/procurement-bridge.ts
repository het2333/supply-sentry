import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { InboundEmail } from '@readywork/connectors';
import { extractPoNumber } from '@readywork/connectors';
import type { InboundMessageEnvelope, StoredInboundMessage } from '@readywork/messaging';
import { ProcurementValidationError } from '@readywork/persistence';
import { redactSensitive } from '../http-errors.js';
import { InboundPurchaseOrderEmailError, resolvePurchaseOrderNumberFromEmailThread } from '../procurement-inbound-email.js';
import { ingestInboundPurchaseOrderEmailWithAi } from '../procurement-ai-reply.js';
import { persistInboundEmailAttachments } from '../procurement-po-intake.js';
import { recordInboundMailRejection, resolveInboundMailRejection } from '../procurement-inbound-mail-monitor.js';
import {
  resolveSupplierEmailIdentityIncidentsAfterSuccessfulIngest,
  resolveSupplierEmailIdentityIncidentsForMailboxSelfSender,
} from '../production-operations.js';

export interface NormalizeInboundEmailInput {
  readonly tenantId: string;
  readonly adapterId: string;
  readonly provider: string;
  readonly mailbox: string;
  readonly email: InboundEmail;
}

export interface PurchaseOrderEmailProcessingResult {
  readonly retryable: boolean;
  readonly purchaseOrderId: string;
  readonly purchaseOrderNumber: string;
  readonly communicationId: string;
  readonly analysis: { readonly status: string };
}

export type ProcurementBridgeResult =
  | { readonly status: 'processed'; readonly communicationId?: string; readonly purchaseOrderId?: string; readonly analysisStatus?: string }
  | { readonly status: 'rejected'; readonly reasonCode: string }
  | { readonly status: 'retryable_failure'; readonly error: string };

export interface ProcurementMessagingBridgeOptions {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  readonly provider: string;
  readonly mailbox: string;
  readonly mailboxAddress?: string;
  readonly processPurchaseOrderEmail?: (input: {
    readonly db: DatabaseSync;
    readonly tenantId: string;
    readonly provider: string;
    readonly mailbox: string;
    readonly email: InboundEmail;
    readonly poNumber: string;
    readonly gatewayInboundId: string;
  }) => Promise<PurchaseOrderEmailProcessingResult>;
}

export class ProcurementMessagingBridge {
  private readonly processPurchaseOrderEmail: NonNullable<ProcurementMessagingBridgeOptions['processPurchaseOrderEmail']>;

  constructor(private readonly options: ProcurementMessagingBridgeOptions) {
    this.processPurchaseOrderEmail = options.processPurchaseOrderEmail ?? (async (input) => {
      const result = await ingestInboundPurchaseOrderEmailWithAi({
        db: input.db,
        tenantId: input.tenantId,
        provider: input.provider,
        mailbox: input.mailbox,
        email: input.email,
        poNumber: input.poNumber,
        gatewayInboundId: input.gatewayInboundId,
      });
      return result;
    });
  }

  async handle(message: StoredInboundMessage, originalEmail?: InboundEmail): Promise<ProcurementBridgeResult> {
    const envelope = message.envelope;
    if (envelope.tenantId !== this.options.tenantId) return { status: 'rejected', reasonCode: 'TENANT_MISMATCH' };
    if (envelope.channel !== 'email') return { status: 'rejected', reasonCode: 'UNSUPPORTED_CHANNEL' };
    if (envelope.attachments.length !== (message.attachments ?? []).length) {
      return {status:'retryable_failure',error:'持久化附件不完整，等待原始消息恢复'};
    }
    const email = emailFromEnvelope(envelope);
    // Replay identity comes from the durable input, even if IMAP configuration
    // has since been removed or changed.
    const provider = envelope.provider;
    const mailbox = envelope.recipients[0]?.address ?? this.options.mailbox;
    const replayEmail: InboundEmail = { ...email, attachments:(message.attachments??[]).map(attachment=>({
      filename:attachment.name,contentType:attachment.contentType,content:attachment.content,
    })) };
    if (this.options.mailboxAddress) {
      const selfSender = resolveSupplierEmailIdentityIncidentsForMailboxSelfSender(this.options.db, {
        tenantId: this.options.tenantId,
        providerUid: email.id,
        observedSender: email.from,
        mailboxAddress: this.options.mailboxAddress,
      });
      if (selfSender.matched) {
        resolveInboundMailRejection(this.options.db, this.options.tenantId, provider, mailbox, email.id);
        return { status: 'rejected', reasonCode: 'SELF_SENDER_COPY' };
      }
    }

    const poNumber = extractPoNumber(email.subject, email.body)
      ?? resolvePurchaseOrderNumberFromEmailThread(this.options.db, this.options.tenantId, email);
    if (!poNumber) {
      const intake = persistInboundEmailAttachments({
            db: this.options.db,
            tenantId: this.options.tenantId,
            provider,
            mailbox,
            email: replayEmail,
            ownerType: 'po_intake',
          });
      if (intake.candidateIds.length > 0) {
        resolveInboundMailRejection(this.options.db, this.options.tenantId, provider, mailbox, email.id);
        return { status: 'processed' };
      }
      recordInboundMailRejection(this.options.db, this.options.tenantId, {
        provider,
        mailbox,
        providerUid: email.id,
        messageId: email.messageId,
        observedSender: email.from,
        poNumber: '(unmatched)',
        reasonCode: 'NO_PO_OR_ATTACHMENT',
      });
      return { status: 'rejected', reasonCode: 'NO_PO_OR_ATTACHMENT' };
    }

    try {
      const result = await this.processPurchaseOrderEmail({
        db: this.options.db,
        tenantId: this.options.tenantId,
        provider,
        mailbox,
        email: replayEmail,
        poNumber,
        gatewayInboundId: envelope.id,
      });
      if (result.retryable) return { status: 'retryable_failure', error: '供应商回信 AI 处理等待安全重试' };
      resolveInboundMailRejection(this.options.db, this.options.tenantId, provider, mailbox, email.id);
      resolveSupplierEmailIdentityIncidentsAfterSuccessfulIngest(this.options.db, this.options.tenantId, email.id);
      {
        persistInboundEmailAttachments({
          db: this.options.db,
          tenantId: this.options.tenantId,
          provider,
          mailbox,
          email: replayEmail,
          ownerType: 'purchase_order',
          ownerId: result.purchaseOrderId,
        });
      }
      return {
        status: 'processed',
        communicationId: result.communicationId,
        purchaseOrderId: result.purchaseOrderId,
        analysisStatus: result.analysis.status,
      };
    } catch (error) {
      if (error instanceof ProcurementValidationError) {
        recordInboundMailRejection(this.options.db, this.options.tenantId, {
          provider,
          mailbox,
          providerUid: email.id,
          messageId: email.messageId,
          observedSender: email.from,
          poNumber,
          reasonCode: error.code,
        });
        return { status: 'rejected', reasonCode: error.code };
      }
      if (error instanceof InboundPurchaseOrderEmailError) {
        recordInboundMailRejection(this.options.db, this.options.tenantId, {
          provider,
          mailbox,
          providerUid: email.id,
          messageId: email.messageId,
          observedSender: email.from,
          poNumber,
          reasonCode: error.code,
        });
        if (error.code === 'INVALID_INBOUND_EMAIL' || error.code === 'PO_NOT_FOUND') {
          return { status: 'rejected', reasonCode: error.code };
        }
      }
      return { status: 'retryable_failure', error: redactSensitive(error,500) };
    }
  }
}

export function normalizeInboundEmailEnvelope(input: NormalizeInboundEmailInput): InboundMessageEnvelope {
  const providerMessageId = input.email.messageId?.trim() || `${input.mailbox}:${input.email.id}`;
  const identity = `${input.tenantId}\0email\0${input.adapterId}\0${providerMessageId}`;
  const sender = parseAddress(input.email.from);
  const attachments = (input.email.attachments ?? []).map((attachment, index) => {
    const content = Buffer.from(attachment.content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    return {
      id: `messaging-inbound-attachment:${createHash('sha256').update(`${identity}\0${index}\0${sha256}`).digest('hex')}`,
      name: attachment.filename,
      contentType: attachment.contentType,
      sizeBytes: content.byteLength,
      sha256,
    };
  });
  const immutable = stableJson({
    sender: sender.address.toLowerCase(),
    subject: input.email.subject,
    text: input.email.body,
    attachments: attachments.map(({ id: _id, ...descriptor }) => descriptor),
    occurredAt: input.email.receivedAt,
  });
  return {
    id: `messaging-inbound:${createHash('sha256').update(identity).digest('hex')}`,
    tenantId: input.tenantId,
    adapterId: input.adapterId,
    channel: 'email',
    provider: input.provider,
    providerMessageId,
    conversationId: `imap-uid:${input.email.id}`,
    ...(input.email.inReplyTo ? { inReplyTo: input.email.inReplyTo } : {}),
    references: [...(input.email.references ?? [])],
    sender,
    recipients: [{ address: input.mailbox }],
    subject: input.email.subject,
    text: input.email.body,
    attachments,
    occurredAt: input.email.receivedAt,
    receivedAt: new Date().toISOString(),
    rawFingerprint: createHash('sha256').update(immutable).digest('hex'),
  };
}

function emailFromEnvelope(envelope: InboundMessageEnvelope): InboundEmail {
  const display = envelope.sender.displayName?.trim();
  const uid = envelope.conversationId?.startsWith('imap-uid:')
    ? envelope.conversationId.slice('imap-uid:'.length)
    : envelope.id;
  return {
    id: uid,
    from: display ? `${display} <${envelope.sender.address}>` : envelope.sender.address,
    subject: envelope.subject ?? '(无主题)',
    body: envelope.text,
    receivedAt: envelope.occurredAt,
    messageId: envelope.providerMessageId,
    ...(envelope.inReplyTo ? { inReplyTo: envelope.inReplyTo } : {}),
    ...(envelope.references.length > 0 ? { references: [...envelope.references] } : {}),
  };
}

function parseAddress(value: string): { address: string; displayName?: string } {
  const match = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/u.exec(value);
  if (match) {
    const displayName = match[1]?.replace(/^['"]|['"]$/g, '').trim();
    return {
      address: match[2]!.trim().toLowerCase(),
      ...(displayName ? { displayName } : {}),
    };
  }
  const address = value.trim().replace(/^mailto:/iu, '').toLowerCase();
  return { address };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
