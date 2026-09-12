/**
 * Hermes owns the platform catalog, so Readywork deliberately does not model
 * channels as a closed TypeScript union. Persisted identifiers are still
 * validated at every boundary before they are used as adapter keys.
 */
export type MessagingChannel = string;

const MESSAGING_CHANNEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,95}$/u;

export function isValidMessagingChannel(value: unknown): value is MessagingChannel {
  return typeof value === 'string' && MESSAGING_CHANNEL_PATTERN.test(value);
}

export type MessagingCapability =
  | 'send_text'
  | 'send_attachments'
  | 'receive'
  | 'threads'
  | 'delivery_receipts';

export type MessagingAdapterStatus =
  | 'running'
  | 'degraded'
  | 'paused'
  | 'paused_by_breaker'
  | 'disabled'
  | 'unconfigured';

export interface MessageAddress {
  readonly address: string;
  readonly displayName?: string;
}

export interface MessageSenderAddress {
  readonly address?: string;
  readonly displayName?: string;
}

export interface MessageAttachmentDescriptor {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface MessageAttachmentPayload extends MessageAttachmentDescriptor {
  readonly content: Buffer;
}

export interface InboundMessageEnvelope {
  readonly id: string;
  readonly tenantId: string;
  readonly adapterId: string;
  readonly channel: MessagingChannel;
  readonly provider: string;
  readonly providerMessageId: string;
  readonly conversationId?: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly sender: MessageAddress;
  readonly recipients: readonly MessageAddress[];
  readonly subject?: string;
  readonly text: string;
  readonly attachments: readonly MessageAttachmentDescriptor[];
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly rawFingerprint: string;
}

export interface MessageDeliveryRequest {
  readonly tenantId: string;
  readonly adapterId: string;
  readonly channel: MessagingChannel;
  readonly idempotencyKey: string;
  readonly sender?: MessageSenderAddress;
  readonly recipients: readonly MessageAddress[];
  readonly subject?: string;
  readonly text: string;
  readonly attachments: readonly MessageAttachmentPayload[];
  readonly thread?: { readonly inReplyTo?: string; readonly references?: readonly string[] };
  readonly trace: { readonly source: string; readonly sourceId: string; readonly correlationId: string };
}

export interface StoredMessageDeliveryRequest extends Omit<MessageDeliveryRequest, 'attachments'> {
  readonly attachments: readonly MessageAttachmentDescriptor[];
}

export interface MessageDeliveryReceipt {
  readonly deliveryId: string;
  readonly status: 'accepted' | 'failed' | 'unknown' | 'deferred' | 'blocked';
  /** Scheduling fact. Waiting or blocked receipts are never uncertain dispatches. */
  readonly nextAttemptAt?: string;
  readonly providerMessageId?: string;
  readonly acceptedAt?: string;
  readonly attempt: number;
  readonly replayed: boolean;
  /** True only when no external dispatch began and a later retry is safe. */
  readonly retryable?: boolean;
  readonly error?: string;
}

export type AdapterSendResult =
  | { readonly kind: 'accepted'; readonly providerMessageId: string; readonly acceptedAt: string }
  | { readonly kind: 'retryable_before_dispatch'; readonly error: string }
  | { readonly kind: 'failed_before_dispatch'; readonly error: string }
  | { readonly kind: 'unknown_after_dispatch'; readonly error: string };

export type AdapterFailure = Exclude<AdapterSendResult, { readonly kind: 'accepted' }>;

export interface AdapterHealth {
  readonly ok: boolean;
  readonly message?: string;
}

export interface AdapterPollInput {
  readonly trigger?: 'automatic' | 'manual';
  readonly excludeUids?: ReadonlySet<string>;
  readonly priorityUids?: ReadonlySet<string>;
}

export interface AdapterPollResult {
  readonly status: 'received' | 'failed' | 'blocked';
  readonly handledCount: number;
  readonly error?: string;
}

export interface MessagingAdapter {
  readonly id: string;
  readonly channel: MessagingChannel;
  readonly provider: string;
  readonly capabilities: readonly MessagingCapability[];
  health(): Promise<AdapterHealth>;
  send(request: MessageDeliveryRequest): Promise<AdapterSendResult>;
  poll?(input: AdapterPollInput, signal: AbortSignal): Promise<{ handledCount: number }>;
  close?(): Promise<void>;
}

export interface MessagingAdapterState {
  readonly configured?: boolean;
  readonly startedAt?: string;
  readonly tenantId: string;
  readonly adapterId: string;
  readonly channel: MessagingChannel;
  readonly provider: string;
  readonly status: MessagingAdapterStatus;
  readonly capabilities: readonly MessagingCapability[];
  readonly consecutiveFailures: number;
  readonly failureWindowStartedAt?: string;
  readonly lastHealthAt?: string;
  readonly lastSuccessAt?: string;
  readonly lastError?: string;
  readonly pauseReason?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredInboundMessage {
  /** Bytes held separately from the immutable descriptor envelope, never in audit events. */
  readonly attachments?: readonly MessageAttachmentPayload[];
  readonly envelope: InboundMessageEnvelope;
  readonly status: 'received' | 'dispatching' | 'processed' | 'rejected' | 'failed';
  readonly attempts: number;
  readonly version: number;
  readonly leaseOwner?: string;
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: string;
  readonly outcomeCode?: string;
  readonly error?: string;
  readonly processedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredDelivery {
  readonly id: string;
  readonly request: StoredMessageDeliveryRequest;
  readonly requestFingerprint: string;
  readonly status: 'pending' | 'sending' | 'accepted' | 'retry_wait' | 'unknown' | 'failed' | 'abandoned';
  readonly attempts: number;
  readonly version: number;
  readonly externalDispatchStarted: boolean;
  readonly providerMessageId?: string;
  readonly acceptedAt?: string;
  readonly nextAttemptAt?: string;
  readonly error?: string;
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MessagingGatewayEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly adapterId: string;
  readonly eventType: string;
  readonly status: string;
  readonly actorId?: string;
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}
