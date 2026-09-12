import { createHash } from 'node:crypto';
import type {
  AdapterFailure,
  AdapterPollInput,
  AdapterPollResult,
  InboundMessageEnvelope,
  MessageAttachmentPayload,
  MessageDeliveryReceipt,
  MessageDeliveryRequest,
  MessagingAdapter,
  MessagingAdapterState,
  MessagingCapability,
  StoredDelivery,
} from './contracts.js';
import { isAdapterBlocked, recordAdapterFailure, recordAdapterSuccess } from './circuit-breaker.js';
import { MessagingRepository } from './repository.js';
import { safeMessagingError } from './safe-error.js';

export interface MessageGatewayOptions {
  readonly now?: () => string;
}

export class MessageGateway {
  private readonly adapters = new Map<string, MessagingAdapter>();
  private readonly now: () => string;

  constructor(
    private readonly repository: MessagingRepository,
    options: MessageGatewayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.repository.recoverExpiredDeliveries(this.now());
  }

  register(adapter: MessagingAdapter): void {
    const registered = this.adapters.get(adapter.id);
    if (registered && registered !== adapter) throw new Error(`消息适配器已注册: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    const previous=this.repository.getAdapterState(adapter.id);
    if (!previous) {
      const at = this.now();
      this.repository.saveAdapterState({
        tenantId: this.repository.tenantId,
        adapterId: adapter.id,
        channel: adapter.channel,
        provider: adapter.provider,
        status: 'degraded',
        startedAt: at,
        capabilities: [...adapter.capabilities],
        consecutiveFailures: 0,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
    } else if (registered !== adapter) {
      this.repository.saveAdapterState({...previous,startedAt:this.now(),updatedAt:this.now()},previous.version);
    }
  }

  async deliver(request: MessageDeliveryRequest): Promise<MessageDeliveryReceipt> {
    const at = this.now();
    this.repository.recoverExpiredDeliveries(at);
    const reserved = this.repository.reserveDelivery(request, at);
    const prior = replayReceipt(reserved.delivery, reserved.replayed, at);
    if (prior) return prior;

    if (reserved.delivery.status === 'sending') {
      return {
        deliveryId: reserved.delivery.id,
        status: 'unknown',
        attempt: reserved.delivery.attempts,
        replayed: true,
        error: '投递正在执行或上次执行结果尚未核对，禁止重复发送',
      };
    }
    if (reserved.delivery.status === 'retry_wait') {
      if (!reserved.delivery.nextAttemptAt || reserved.delivery.nextAttemptAt > at) {
        return deliveryReceipt(reserved.delivery, true);
      }
      if (reserved.delivery.attempts >= 3) {
        const failed = this.repository.failDeliveryBeforeDispatch(
          reserved.delivery.id,
          reserved.delivery.version,
          '安全重试次数已用尽',
          at,
        );
        return deliveryReceipt(failed, false);
      }
    }

    const adapter = this.adapters.get(request.adapterId);
    const validationError = this.validateRequest(adapter, request);
    if (validationError) {
      const failed = this.repository.failDeliveryBeforeDispatch(
        reserved.delivery.id,
        reserved.delivery.version,
        validationError,
        at,
      );
      return deliveryReceipt(failed, false);
    }
    if (!adapter) throw new Error('不可达：适配器校验未返回错误');

    const state = this.requiredAdapterState(adapter.id);
    if (isAdapterBlocked(state)) return {
      deliveryId:reserved.delivery.id,status:'blocked',attempt:reserved.delivery.attempts,replayed:true,
      nextAttemptAt:new Date(Date.parse(at)+30_000).toISOString(),error:'消息适配器暂停、熔断、禁用或未配置，等待可派发状态',
    };
    const sending = this.repository.markDeliverySending(reserved.delivery.id, reserved.delivery.version, at);
    let result;
    try {
      result = await adapter.send(request);
    } catch {
      result = {
        kind: 'unknown_after_dispatch' as const,
        error: '适配器调用异常且外部投递结果未知',
      };
    }

    if (result.kind === 'accepted') {
      const accepted = this.repository.completeDelivery(sending.id, sending.version, result, this.now());
      this.saveState(recordAdapterSuccess(this.requiredAdapterState(adapter.id), accepted.updatedAt, state.version));
      this.appendDeliveryEvent(accepted);
      return deliveryReceipt(accepted, false);
    }

    const failed = this.repository.failDelivery(sending.id, sending.version, result, this.now());
    this.saveState(recordAdapterFailure(this.requiredAdapterState(adapter.id), result, failed.updatedAt));
    this.appendDeliveryEvent(failed);
    return deliveryReceipt(failed, false);
  }

  async ingest(envelope: InboundMessageEnvelope, attachments: readonly MessageAttachmentPayload[] = []): Promise<{ inboundId: string; replayed: boolean }> {
    const stored = this.repository.receive(envelope,attachments);
    if (!stored.replayed) {
      this.repository.appendEvent({
        id: eventId('inbound_received', envelope.adapterId, envelope.id, envelope.receivedAt),
        tenantId: envelope.tenantId,
        adapterId: envelope.adapterId,
        eventType: 'inbound_received',
        status: 'received',
        metadata: {
          inboundId: envelope.id,
          channel: envelope.channel,
          providerMessageIdHash: createHash('sha256').update(envelope.providerMessageId).digest('hex'),
        },
        createdAt: envelope.receivedAt,
      });
    }
    return { inboundId: stored.message.envelope.id, replayed: stored.replayed };
  }

  getAdapterState(adapterId: string): MessagingAdapterState {
    return this.requiredAdapterState(adapterId);
  }

  pauseAdapter(
    adapterId: string,
    expectedVersion: number,
    actorId: string,
    reason: string,
  ): MessagingAdapterState {
    if (!reason.trim()) throw new Error('暂停原因不能为空');
    const current = this.requiredAdapterState(adapterId);
    const at = this.now();
    const saved = this.repository.saveAdapterState({
      ...current,
      status: 'paused',
      pauseReason: reason.trim(),
      updatedAt: at,
    }, expectedVersion);
    this.appendAdapterEvent('adapter_paused', saved, actorId, reason.trim());
    return saved;
  }

  resumeAdapter(
    adapterId: string,
    expectedVersion: number,
    actorId: string,
    reason: string,
  ): MessagingAdapterState {
    if (!reason.trim()) throw new Error('恢复原因不能为空');
    const current = this.requiredAdapterState(adapterId);
    const at = this.now();
    const saved = this.repository.saveAdapterState({
      ...current,
      status: current.configured === false ? 'unconfigured' : 'degraded',
      consecutiveFailures: 0,
      failureWindowStartedAt: undefined,
      lastError: undefined,
      pauseReason: undefined,
      updatedAt: at,
    }, expectedVersion);
    this.appendAdapterEvent('adapter_resumed', saved, actorId, reason.trim());
    return saved;
  }

  async health(): Promise<MessagingAdapterState[]> {
    const states: MessagingAdapterState[] = [];
    for (const adapter of this.adapters.values()) {
      const current = this.requiredAdapterState(adapter.id);
      if (current.status === 'paused' || current.status === 'paused_by_breaker' || current.status === 'disabled') {
        states.push(current);
        continue;
      }
      const at = this.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([adapter.health(),new Promise<{ok:false;message:string}>(resolve=>{
        timer=setTimeout(()=>resolve({ok:false,message:'渠道健康检查超时'}),10_000);
      })]).catch(error=>({ok:false,message:safeMessagingError(error)})).finally(()=>clearTimeout(timer));
      const latest=this.requiredAdapterState(adapter.id);
      if (latest.version !== current.version) {
        states.push(latest);
        continue;
      }
      const saved = this.repository.saveAdapterState({
        ...latest,
        status: isAdapterBlocked(latest) ? latest.status : result.ok ? 'running' : 'degraded',
        lastHealthAt: at,
        ...(result.message ? { lastError: result.message } : {}),
        updatedAt: at,
      }, latest.version);
      states.push(saved);
    }
    return states;
  }

  async poll(adapterId: string, input: AdapterPollInput): Promise<AdapterPollResult> {
    const state=this.requiredAdapterState(adapterId);
    if (isAdapterBlocked(state)) return {status:'blocked',handledCount:0,error:'收件适配器已暂停、熔断、禁用或未配置'};
    const adapter=this.adapters.get(adapterId);
    if (!adapter?.capabilities.includes('receive') || !adapter.poll) return {status:'blocked',handledCount:0,error:'收件适配器尚未启动'};
    const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const result=await Promise.race([adapter.poll(input,controller.signal),new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(new Error('IMAP 收件检查超时'));},60_000);
      })]);
      this.saveState(recordAdapterSuccess(this.requiredAdapterState(adapterId),this.now(),state.version));
      return {status:'received',handledCount:result.handledCount};
    } catch(error) {
      const safe=safeMessagingError(error);
      this.saveState(recordAdapterFailure(this.requiredAdapterState(adapterId),{kind:'retryable_before_dispatch',error:safe},this.now()));
      return {status:'failed',handledCount:0,error:safe};
    } finally {clearTimeout(timer);}
  }

  async close(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.close?.()));
  }

  private validateRequest(adapter: MessagingAdapter | undefined, request: MessageDeliveryRequest): string | undefined {
    if (!adapter) return `消息适配器未注册: ${request.adapterId}`;
    if (adapter.channel !== request.channel) return `消息适配器渠道不匹配: ${adapter.channel} != ${request.channel}`;
    const required: MessagingCapability[] = ['send_text'];
    if (request.attachments.length > 0) required.push('send_attachments');
    if (request.thread?.inReplyTo || request.thread?.references?.length) required.push('threads');
    const missing = required.filter((capability) => !adapter.capabilities.includes(capability));
    return missing.length > 0 ? `消息适配器缺少能力: ${missing.join(',')}` : undefined;
  }

  private saveState(next: MessagingAdapterState): MessagingAdapterState {
    return this.repository.saveAdapterState(next, next.version);
  }

  private requiredAdapterState(adapterId: string): MessagingAdapterState {
    const state = this.repository.getAdapterState(adapterId);
    if (!state) throw new Error(`消息适配器状态不存在: ${adapterId}`);
    return state;
  }

  private appendDeliveryEvent(delivery: StoredDelivery): void {
    this.repository.appendEvent({
      id: eventId('delivery_status_changed', delivery.request.adapterId, delivery.id, String(delivery.version)),
      tenantId: delivery.request.tenantId,
      adapterId: delivery.request.adapterId,
      eventType: 'delivery_status_changed',
      status: delivery.status,
      metadata: {
        deliveryId: delivery.id,
        source: delivery.request.trace.source,
        sourceId: delivery.request.trace.sourceId,
        attempts: delivery.attempts,
      },
      createdAt: delivery.updatedAt,
    });
  }

  private appendAdapterEvent(
    eventType: 'adapter_paused' | 'adapter_resumed',
    state: MessagingAdapterState,
    actorId: string,
    reason: string,
  ): void {
    this.repository.appendEvent({
      id: eventId(eventType, state.adapterId, String(state.version), state.updatedAt),
      tenantId: state.tenantId,
      adapterId: state.adapterId,
      eventType,
      status: state.status,
      actorId,
      reason,
      metadata: { adapterVersion: state.version },
      createdAt: state.updatedAt,
    });
  }
}

function replayReceipt(delivery: StoredDelivery, replayed: boolean, at: string): MessageDeliveryReceipt | undefined {
  if (!replayed) return undefined;
  if (delivery.status === 'accepted' || delivery.status === 'unknown' || delivery.status === 'failed' || delivery.status === 'abandoned') {
    return deliveryReceipt(delivery, true);
  }
  if (delivery.status === 'retry_wait' && delivery.nextAttemptAt && delivery.nextAttemptAt > at) {
    return deliveryReceipt(delivery, true);
  }
  return undefined;
}

function deliveryReceipt(delivery: StoredDelivery, replayed: boolean): MessageDeliveryReceipt {
  const status = delivery.status === 'accepted' ? 'accepted' : delivery.status === 'unknown' ? 'unknown' : delivery.status === 'retry_wait' ? 'deferred' : 'failed';
  return {
    deliveryId: delivery.id,
    status,
    ...(delivery.providerMessageId ? { providerMessageId: delivery.providerMessageId } : {}),
    ...(delivery.acceptedAt ? { acceptedAt: delivery.acceptedAt } : {}),
    attempt: delivery.attempts,
    replayed,
    ...(delivery.nextAttemptAt ? {nextAttemptAt:delivery.nextAttemptAt}:{}),
    ...(delivery.status === 'retry_wait' ? { retryable: true } : {}),
    ...(delivery.error ? { error: delivery.error } : {}),
  };
}

function eventId(eventType: string, adapterId: string, subjectId: string, discriminator: string): string {
  return `messaging-event:${createHash('sha256')
    .update(`${eventType}\0${adapterId}\0${subjectId}\0${discriminator}`)
    .digest('hex')}`;
}
