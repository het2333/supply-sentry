export type {
  AdapterFailure,
  AdapterHealth,
  AdapterPollInput,
  AdapterPollResult,
  AdapterSendResult,
  InboundMessageEnvelope,
  MessageAddress,
  MessageAttachmentDescriptor,
  MessageAttachmentPayload,
  MessageDeliveryReceipt,
  MessageDeliveryRequest,
  MessageSenderAddress,
  MessagingAdapter,
  MessagingAdapterState,
  MessagingAdapterStatus,
  MessagingCapability,
  MessagingChannel,
  MessagingGatewayEvent,
  StoredDelivery,
  StoredInboundMessage,
  StoredMessageDeliveryRequest,
} from './contracts.js';
export { recordAdapterFailure, recordAdapterSuccess } from './circuit-breaker.js';
export { isValidMessagingChannel } from './contracts.js';
export { MessageGateway } from './gateway.js';
export type { MessageGatewayOptions } from './gateway.js';
export {
  MessagingAdapterVersionConflictError,
  MessagingDeliveryIdempotencyConflictError,
  MessagingDeliveryVersionConflictError,
  MessagingInboundIdentityConflictError,
  MessagingInboundStateConflictError,
  MessagingRepository,
} from './repository.js';
