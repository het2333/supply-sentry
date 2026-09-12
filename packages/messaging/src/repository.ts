import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { safeMessagingError } from './safe-error.js';
import type {
  AdapterFailure,
  AdapterSendResult,
  InboundMessageEnvelope,
  MessageDeliveryRequest,
  MessageAttachmentPayload,
  MessagingAdapterState,
  MessagingGatewayEvent,
  StoredDelivery,
  StoredInboundMessage,
  StoredMessageDeliveryRequest,
} from './contracts.js';

interface InboundRow {
  envelope_json: string;
  status: StoredInboundMessage['status'];
  attempts: number;
  version: number;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  outcome_code: string | null;
  error: string | null;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  request_json: string;
  request_fingerprint: string;
  status: StoredDelivery['status'];
  attempts: number;
  version: number;
  external_dispatch_started: number;
  provider_message_id: string | null;
  accepted_at: string | null;
  next_attempt_at: string | null;
  error: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AdapterStateRow {
  configured: number;
  started_at: string | null;
  tenant_id: string;
  adapter_id: string;
  channel: MessagingAdapterState['channel'];
  provider: string;
  status: MessagingAdapterState['status'];
  capabilities_json: string;
  consecutive_failures: number;
  failure_window_started_at: string | null;
  last_health_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  pause_reason: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export class MessagingRepository {
  constructor(private readonly db: DatabaseSync, readonly tenantId: string) {
    if (!tenantId.trim()) throw new Error('消息仓储租户不能为空');
  }

  receive(envelope: InboundMessageEnvelope, attachments: readonly MessageAttachmentPayload[] = []): { message: StoredInboundMessage; replayed: boolean } {
    this.db.exec('SAVEPOINT messaging_receive');
    try {
      const result=this.receiveEnvelope(envelope);
      for (const descriptor of envelope.attachments) {
        const content=attachments.find(item=>item.id===descriptor.id)?.content;
        if (content) {
          if (content.byteLength!==descriptor.sizeBytes || createHash('sha256').update(content).digest('hex')!==descriptor.sha256) throw new Error('入站附件字节与描述符不符');
          this.db.prepare(`INSERT OR IGNORE INTO messaging_inbound_attachments (tenant_id,inbound_id,id,descriptor_json,content) VALUES (?,?,?,?,?)`)
            .run(this.tenantId,result.message.envelope.id,descriptor.id,JSON.stringify(descriptor),content);
        }
      }
      const message=this.requiredInbound(result.message.envelope.id);
      if (message.attachments?.length!==envelope.attachments.length) throw new Error('入站附件字节未可靠持久化，禁止确认接收');
      this.db.exec('RELEASE messaging_receive');
      return {...result,message};
    } catch(error) {this.db.exec('ROLLBACK TO messaging_receive; RELEASE messaging_receive');throw error;}
  }

  private receiveEnvelope(envelope: InboundMessageEnvelope): { message: StoredInboundMessage; replayed: boolean } {
    this.requireTenant(envelope.tenantId);
    const existing = this.db.prepare(`SELECT envelope_json,status,attempts,version,lease_owner,lease_token,lease_expires_at,
      outcome_code,error,processed_at,created_at,updated_at
      FROM messaging_inbound_messages
      WHERE tenant_id=? AND channel=? AND adapter_id=? AND provider_message_id=?`)
      .get(this.tenantId, envelope.channel, envelope.adapterId, envelope.providerMessageId) as InboundRow | undefined;
    if (existing) {
      const message = inboundFromRow(existing);
      if (message.envelope.rawFingerprint !== envelope.rawFingerprint) {
        throw new MessagingInboundIdentityConflictError(envelope.providerMessageId);
      }
      return { message, replayed: true };
    }

    const json = JSON.stringify(envelope);
    this.db.prepare(`INSERT INTO messaging_inbound_messages
      (tenant_id,id,adapter_id,channel,provider,provider_message_id,raw_fingerprint,status,envelope_json,
       attempts,version,received_at,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'received',?,0,1,?,?,?)`).run(
      this.tenantId,
      envelope.id,
      envelope.adapterId,
      envelope.channel,
      envelope.provider,
      envelope.providerMessageId,
      envelope.rawFingerprint,
      json,
      envelope.receivedAt,
      envelope.receivedAt,
      envelope.receivedAt,
    );
    const inserted = this.getInboundById(envelope.id);
    if (!inserted) throw new Error('消息入站记录写入后不可读');
    return { message: inserted, replayed: false };
  }

  listInbound(input: { status?: StoredInboundMessage['status']; limit?: number } = {}): StoredInboundMessage[] {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const rows = (input.status
      ? this.db.prepare(`SELECT envelope_json,status,attempts,version,lease_owner,lease_token,lease_expires_at,
          outcome_code,error,processed_at,created_at,updated_at
          FROM messaging_inbound_messages WHERE tenant_id=? AND status=? ORDER BY received_at,id LIMIT ?`)
        .all(this.tenantId, input.status, limit)
      : this.db.prepare(`SELECT envelope_json,status,attempts,version,lease_owner,lease_token,lease_expires_at,
          outcome_code,error,processed_at,created_at,updated_at
          FROM messaging_inbound_messages WHERE tenant_id=? ORDER BY received_at,id LIMIT ?`)
        .all(this.tenantId, limit)) as unknown as InboundRow[];
    return rows.map(row=>this.withInboundAttachments(inboundFromRow(row)));
  }

  reserveDelivery(request: MessageDeliveryRequest, at: string): { delivery: StoredDelivery; owner: boolean; replayed: boolean } {
    this.requireTenant(request.tenantId);
    const storedRequest = storedDeliveryRequest(request);
    const requestJson = stableJson(storedRequest);
    const fingerprint = createHash('sha256').update(requestJson).digest('hex');
    const existing = this.db.prepare(`SELECT id,request_json,request_fingerprint,status,attempts,version,
      external_dispatch_started,provider_message_id,accepted_at,next_attempt_at,error,completed_at,created_at,updated_at
      FROM messaging_deliveries WHERE tenant_id=? AND adapter_id=? AND idempotency_key=?`)
      .get(this.tenantId, request.adapterId, request.idempotencyKey) as DeliveryRow | undefined;
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new MessagingDeliveryIdempotencyConflictError(request.idempotencyKey);
      return { delivery: deliveryFromRow(existing), owner: false, replayed: true };
    }

    const id = `messaging-delivery:${createHash('sha256')
      .update(`${this.tenantId}\0${request.adapterId}\0${request.idempotencyKey}`)
      .digest('hex')}`;
    this.db.prepare(`INSERT INTO messaging_deliveries
      (tenant_id,id,adapter_id,channel,idempotency_key,request_fingerprint,status,request_json,attempts,version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'pending',?,0,1,?,?)`).run(
      this.tenantId,
      id,
      request.adapterId,
      request.channel,
      request.idempotencyKey,
      fingerprint,
      requestJson,
      at,
      at,
    );
    const inserted = this.getDeliveryById(id);
    if (!inserted) throw new Error('消息投递记录写入后不可读');
    return { delivery: inserted, owner: true, replayed: false };
  }

  getDeliveryById(id: string): StoredDelivery | undefined {
    const row = this.db.prepare(`SELECT id,request_json,request_fingerprint,status,attempts,version,
      external_dispatch_started,provider_message_id,accepted_at,next_attempt_at,error,completed_at,created_at,updated_at
      FROM messaging_deliveries WHERE tenant_id=? AND id=?`)
      .get(this.tenantId, id) as DeliveryRow | undefined;
    return row ? deliveryFromRow(row) : undefined;
  }

  markDeliverySending(id: string, expectedVersion: number, at: string): StoredDelivery {
    const updated = this.db.prepare(`UPDATE messaging_deliveries
      SET status='sending',attempts=attempts+1,version=version+1,lease_owner=?,lease_token=?,lease_expires_at=?,external_dispatch_started=1,
          next_attempt_at=NULL,error=NULL,updated_at=?
      WHERE tenant_id=? AND id=? AND version=? AND status IN ('pending','retry_wait','failed')`)
      .run(`gateway:${process.pid}`, `${id}:${expectedVersion}`, new Date(Date.parse(at)+180_000).toISOString(), at, this.tenantId, id, expectedVersion);
    if (Number(updated.changes) !== 1) throw new MessagingDeliveryVersionConflictError(id, expectedVersion);
    return this.requiredDelivery(id);
  }

  recoverExpiredDeliveries(at: string): void {
    this.db.exec('SAVEPOINT messaging_recover');
    try {
      const rows = this.db.prepare(`UPDATE messaging_deliveries SET status='unknown',external_dispatch_started=1,
        error='发送执行租约失联，结果未知，必须人工核对',completed_at=?,updated_at=?,version=version+1,
        lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL
        WHERE tenant_id=? AND status='sending' AND (lease_expires_at<=? OR
          (lease_expires_at IS NULL AND updated_at<=?)) RETURNING id,adapter_id,version`)
        .all(at,at,this.tenantId,at,new Date(Date.parse(at)-180_000).toISOString()) as Array<{id:string;adapter_id:string;version:number}>;
      for (const row of rows) this.appendEvent({id:`recovered:${row.id}:${row.version}`,tenantId:this.tenantId,adapterId:row.adapter_id,
        eventType:'delivery_recovered_unknown',status:'unknown',metadata:{deliveryId:row.id},createdAt:at});
      this.db.exec('RELEASE messaging_recover');
    } catch(error) { this.db.exec('ROLLBACK TO messaging_recover; RELEASE messaging_recover'); throw error; }
  }

  completeDelivery(
    id: string,
    expectedVersion: number,
    receipt: Extract<AdapterSendResult, { kind: 'accepted' }>,
    at: string,
  ): StoredDelivery {
    const updated = this.db.prepare(`UPDATE messaging_deliveries
      SET status='accepted',external_dispatch_started=1,provider_message_id=?,accepted_at=?,receipt_json=?,
          completed_at=?,error=NULL,next_attempt_at=NULL,version=version+1,updated_at=?
      WHERE tenant_id=? AND id=? AND version=? AND status='sending'`)
      .run(receipt.providerMessageId, receipt.acceptedAt, JSON.stringify(receipt), at, at, this.tenantId, id, expectedVersion);
    if (Number(updated.changes) !== 1) throw new MessagingDeliveryVersionConflictError(id, expectedVersion);
    return this.requiredDelivery(id);
  }

  failDelivery(id: string, expectedVersion: number, failure: AdapterFailure, at: string): StoredDelivery {
    failure={...failure,error:safeMessagingError(failure.error)};
    const status: StoredDelivery['status'] = failure.kind === 'unknown_after_dispatch'
      ? 'unknown'
      : failure.kind === 'retryable_before_dispatch' && this.requiredDelivery(id).attempts < 3
        ? 'retry_wait'
        : 'failed';
    const externalDispatchStarted = failure.kind === 'unknown_after_dispatch' ? 1 : 0;
    const nextAttemptAt = status === 'retry_wait'
      ? new Date(new Date(at).getTime() + 30_000).toISOString()
      : null;
    const completedAt = status === 'retry_wait' ? null : at;
    const updated = this.db.prepare(`UPDATE messaging_deliveries
      SET status=?,external_dispatch_started=?,next_attempt_at=?,error=?,receipt_json=?,completed_at=?,
          version=version+1,updated_at=?
      WHERE tenant_id=? AND id=? AND version=? AND status='sending'`)
      .run(
        status,
        externalDispatchStarted,
        nextAttemptAt,
        failure.error,
        JSON.stringify(failure),
        completedAt,
        at,
        this.tenantId,
        id,
        expectedVersion,
      );
    if (Number(updated.changes) !== 1) throw new MessagingDeliveryVersionConflictError(id, expectedVersion);
    return this.requiredDelivery(id);
  }

  failDeliveryBeforeDispatch(id: string, expectedVersion: number, error: string, at: string): StoredDelivery {
    error=safeMessagingError(error);
    const failure: AdapterFailure = { kind: 'failed_before_dispatch', error };
    const updated = this.db.prepare(`UPDATE messaging_deliveries
      SET status='failed',external_dispatch_started=0,next_attempt_at=NULL,error=?,receipt_json=?,completed_at=?,
          version=version+1,updated_at=?
      WHERE tenant_id=? AND id=? AND version=? AND status IN ('pending','retry_wait')`)
      .run(error, JSON.stringify(failure), at, at, this.tenantId, id, expectedVersion);
    if (Number(updated.changes) !== 1) throw new MessagingDeliveryVersionConflictError(id, expectedVersion);
    return this.requiredDelivery(id);
  }

  claimInbound(limit: number, workerId: string, leaseMs: number, at: string): StoredInboundMessage[] {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    if (!workerId.trim()) throw new Error('消息入站领取者不能为空');
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('消息入站租约必须大于零');
    const leaseExpiresAt = new Date(new Date(at).getTime() + leaseMs).toISOString();
    const candidates = this.db.prepare(`SELECT id,version FROM messaging_inbound_messages
      WHERE tenant_id=? AND (
        status IN ('received','failed') OR
        (status='dispatching' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?)
      )
      ORDER BY received_at,id LIMIT ?`).all(this.tenantId, at, boundedLimit) as Array<{ id: string; version: number }>;
    const claimed: StoredInboundMessage[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const candidate of candidates) {
        const leaseToken = createHash('sha256')
          .update(`${this.tenantId}\0${candidate.id}\0${workerId}\0${at}\0${candidate.version}`)
          .digest('hex');
        const result = this.db.prepare(`UPDATE messaging_inbound_messages
          SET status='dispatching',attempts=attempts+1,version=version+1,lease_owner=?,lease_token=?,lease_expires_at=?,
              error=NULL,updated_at=?
          WHERE tenant_id=? AND id=? AND version=? AND (
            status IN ('received','failed') OR
            (status='dispatching' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?)
          )`).run(
          workerId,
          leaseToken,
          leaseExpiresAt,
          at,
          this.tenantId,
          candidate.id,
          candidate.version,
          at,
        );
        if (Number(result.changes) === 1) {
          const message = this.getInboundById(candidate.id);
          if (message) claimed.push(message);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return claimed;
  }

  claimInboundById(id: string, workerId: string, leaseMs: number, at: string): StoredInboundMessage | undefined {
    if (!workerId.trim()) throw new Error('消息入站领取者不能为空');
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error('消息入站租约必须大于零');
    const current = this.getInboundById(id);
    if (!current) return undefined;
    const eligible = current.status === 'received'
      || current.status === 'failed'
      || (current.status === 'dispatching' && Boolean(current.leaseExpiresAt) && current.leaseExpiresAt! <= at);
    if (!eligible) return undefined;
    const leaseExpiresAt = new Date(new Date(at).getTime() + leaseMs).toISOString();
    const leaseToken = createHash('sha256')
      .update(`${this.tenantId}\0${id}\0${workerId}\0${at}\0${current.version}`)
      .digest('hex');
    const result = this.db.prepare(`UPDATE messaging_inbound_messages
      SET status='dispatching',attempts=attempts+1,version=version+1,lease_owner=?,lease_token=?,lease_expires_at=?,
          error=NULL,updated_at=?
      WHERE tenant_id=? AND id=? AND version=? AND (
        status IN ('received','failed') OR
        (status='dispatching' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?)
      )`).run(workerId, leaseToken, leaseExpiresAt, at, this.tenantId, id, current.version, at);
    return Number(result.changes) === 1 ? this.requiredInbound(id) : undefined;
  }

  pendingInboundIds(limit: number, at: string): string[] {
    return (this.db.prepare(`SELECT id FROM messaging_inbound_messages WHERE tenant_id=? AND
      (status IN ('received','failed') OR (status='dispatching' AND lease_expires_at<=?))
      ORDER BY received_at,id LIMIT ?`).all(this.tenantId,at,Math.max(1,Math.min(100,Math.floor(limit)))) as Array<{id:string}>).map(row=>row.id);
  }

  completeInbound(
    id: string,
    status: 'processed' | 'rejected',
    at: string,
    outcomeCode: string,
    lease: Pick<StoredInboundMessage, 'version' | 'leaseToken'>,
  ): StoredInboundMessage {
    this.db.exec('SAVEPOINT messaging_finish_inbound');
    try {
    const result = this.db.prepare(`UPDATE messaging_inbound_messages
      SET status=?,outcome_code=?,processed_at=?,error=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
          version=version+1,updated_at=?
      WHERE tenant_id=? AND id=? AND status='dispatching' AND version=? AND lease_token=? AND lease_expires_at>?`)
      .run(status, outcomeCode, at, at, this.tenantId, id, lease.version, lease.leaseToken ?? null, at);
    if (Number(result.changes) !== 1) throw new MessagingInboundStateConflictError(id);
    const message=this.requiredInbound(id);
    this.appendInboundCompletionEvent(message,at);
    this.db.exec('RELEASE messaging_finish_inbound');
    return message;
    } catch(error) {this.db.exec('ROLLBACK TO messaging_finish_inbound; RELEASE messaging_finish_inbound');throw error;}
  }

  failInbound(id: string, at: string, error: unknown, lease: Pick<StoredInboundMessage, 'version' | 'leaseToken'>): StoredInboundMessage {
    this.db.exec('SAVEPOINT messaging_fail_inbound');
    try {
    const result = this.db.prepare(`UPDATE messaging_inbound_messages
      SET status='failed',error=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,version=version+1,updated_at=?
      WHERE tenant_id=? AND id=? AND status='dispatching' AND version=? AND lease_token=? AND lease_expires_at>?`)
      .run(safeMessagingError(error), at, this.tenantId, id, lease.version, lease.leaseToken ?? null, at);
    if (Number(result.changes) !== 1) throw new MessagingInboundStateConflictError(id);
    const message=this.requiredInbound(id);
    this.appendInboundCompletionEvent(message,at);
    this.db.exec('RELEASE messaging_fail_inbound');
    return message;
    } catch(failure) {this.db.exec('ROLLBACK TO messaging_fail_inbound; RELEASE messaging_fail_inbound');throw failure;}
  }

  private appendInboundCompletionEvent(message: StoredInboundMessage, at: string): void {
    this.appendEvent({id:`inbound-completed:${message.envelope.id}:${message.version}`,tenantId:this.tenantId,adapterId:message.envelope.adapterId,
      eventType:`inbound_domain_${message.status}`,status:message.status,metadata:{inboundId:message.envelope.id},createdAt:at});
  }

  renewInboundLease(message: StoredInboundMessage, at: string, leaseMs: number): boolean {
    return Number(this.db.prepare(`UPDATE messaging_inbound_messages SET lease_expires_at=?
      WHERE tenant_id=? AND id=? AND status='dispatching' AND version=? AND lease_token=? AND lease_expires_at>?`)
      .run(new Date(Date.parse(at)+leaseMs).toISOString(),this.tenantId,message.envelope.id,message.version,message.leaseToken??null,at).changes)===1;
  }

  getAdapterState(adapterId: string): MessagingAdapterState | undefined {
    const row = this.db.prepare(`SELECT tenant_id,adapter_id,channel,provider,status,capabilities_json,configured,started_at,
      consecutive_failures,failure_window_started_at,last_health_at,last_success_at,last_error,pause_reason,
      version,created_at,updated_at
      FROM messaging_adapter_states WHERE tenant_id=? AND adapter_id=?`)
      .get(this.tenantId, adapterId) as AdapterStateRow | undefined;
    return row ? adapterStateFromRow(row) : undefined;
  }

  listAdapterStates(): MessagingAdapterState[] {
    const rows=this.db.prepare('SELECT * FROM messaging_adapter_states WHERE tenant_id=? ORDER BY adapter_id').all(this.tenantId) as unknown as AdapterStateRow[];
    return rows.map(adapterStateFromRow);
  }

  saveAdapterState(state: MessagingAdapterState, expectedVersion?: number): MessagingAdapterState {
    this.db.exec('SAVEPOINT messaging_adapter_state');
    try {
      const previous=this.getAdapterState(state.adapterId);
      const saved=this.writeAdapterState({...state,
        ...(state.lastError?{lastError:safeMessagingError(state.lastError)}:{}),
        ...(state.pauseReason?{pauseReason:safeMessagingError(state.pauseReason)}:{}),
      },expectedVersion);
      const eventType=!previous?'adapter_registered':saved.status==='paused_by_breaker'&&previous.status!=='paused_by_breaker'
        ?'adapter_breaker_opened':previous.startedAt!==saved.startedAt?'adapter_started':previous.status!==saved.status||previous.lastHealthAt!==saved.lastHealthAt?'adapter_health_changed':undefined;
      if (eventType) this.appendEvent({id:`adapter:${saved.adapterId}:${saved.version}:${eventType}`,tenantId:this.tenantId,adapterId:saved.adapterId,
        eventType,status:saved.status,metadata:{adapterVersion:saved.version},createdAt:saved.updatedAt});
      this.db.exec('RELEASE messaging_adapter_state');
      return saved;
    } catch(error) {this.db.exec('ROLLBACK TO messaging_adapter_state; RELEASE messaging_adapter_state');throw error;}
  }

  private writeAdapterState(state: MessagingAdapterState, expectedVersion?: number): MessagingAdapterState {
    this.requireTenant(state.tenantId);
    const existing = this.getAdapterState(state.adapterId);
    if (!existing) {
      if (expectedVersion !== undefined) throw new MessagingAdapterVersionConflictError(state.adapterId, expectedVersion);
      this.db.prepare(`INSERT INTO messaging_adapter_states
        (tenant_id,adapter_id,channel,provider,status,capabilities_json,consecutive_failures,
         failure_window_started_at,last_health_at,last_success_at,last_error,pause_reason,version,created_at,updated_at,configured,started_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`).run(
        this.tenantId,
        state.adapterId,
        state.channel,
        state.provider,
        state.status,
        JSON.stringify(state.capabilities),
        state.consecutiveFailures,
        state.failureWindowStartedAt ?? null,
        state.lastHealthAt ?? null,
        state.lastSuccessAt ?? null,
        state.lastError ?? null,
        state.pauseReason ?? null,
        state.createdAt,
        state.updatedAt,
        state.configured === false ? 0 : 1,
        state.startedAt ?? null,
      );
      return this.requiredAdapterState(state.adapterId);
    }
    if (expectedVersion === undefined || existing.version !== expectedVersion) {
      throw new MessagingAdapterVersionConflictError(state.adapterId, expectedVersion ?? -1);
    }
    const result = this.db.prepare(`UPDATE messaging_adapter_states
      SET channel=?,provider=?,status=?,capabilities_json=?,consecutive_failures=?,failure_window_started_at=?,
          last_health_at=?,last_success_at=?,last_error=?,pause_reason=?,version=version+1,updated_at=?,configured=?,started_at=?
      WHERE tenant_id=? AND adapter_id=? AND version=?`).run(
      state.channel,
      state.provider,
      state.status,
      JSON.stringify(state.capabilities),
      state.consecutiveFailures,
      state.failureWindowStartedAt ?? null,
      state.lastHealthAt ?? null,
      state.lastSuccessAt ?? null,
      state.lastError ?? null,
      state.pauseReason ?? null,
      state.updatedAt,
      state.configured === false ? 0 : 1,
      state.startedAt ?? null,
      this.tenantId,
      state.adapterId,
      expectedVersion,
    );
    if (Number(result.changes) !== 1) throw new MessagingAdapterVersionConflictError(state.adapterId, expectedVersion);
    return this.requiredAdapterState(state.adapterId);
  }

  appendEvent(event: MessagingGatewayEvent): void {
    this.requireTenant(event.tenantId);
    const metadata = sanitizeEventMetadata(event.metadata ?? {});
    this.db.prepare(`INSERT INTO messaging_gateway_events
      (tenant_id,id,adapter_id,event_type,status,actor_id,reason,metadata_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      this.tenantId,
      event.id,
      event.adapterId,
      event.eventType,
      event.status,
      event.actorId ?? null,
      event.reason ? safeMessagingError(event.reason) : null,
      stableJson(metadata),
      event.createdAt,
    );
  }

  private getInboundById(id: string): StoredInboundMessage | undefined {
    const row = this.db.prepare(`SELECT envelope_json,status,attempts,version,lease_owner,lease_token,lease_expires_at,
      outcome_code,error,processed_at,created_at,updated_at
      FROM messaging_inbound_messages WHERE tenant_id=? AND id=?`)
      .get(this.tenantId, id) as InboundRow | undefined;
    return row ? this.withInboundAttachments(inboundFromRow(row)) : undefined;
  }

  private withInboundAttachments(message: StoredInboundMessage): StoredInboundMessage {
    const rows=this.db.prepare('SELECT descriptor_json,content FROM messaging_inbound_attachments WHERE tenant_id=? AND inbound_id=?')
      .all(this.tenantId,message.envelope.id) as Array<{descriptor_json:string;content:Uint8Array}>;
    const byId=new Map(rows.map(row=>{const descriptor=JSON.parse(row.descriptor_json);return [descriptor.id,{...descriptor,content:Buffer.from(row.content)}];}));
    return {...message,attachments:message.envelope.attachments.flatMap(item=>byId.has(item.id)?[byId.get(item.id)!]:[])};
  }

  private requiredInbound(id: string): StoredInboundMessage {
    const message = this.getInboundById(id);
    if (!message) throw new Error(`消息入站记录不存在: ${id}`);
    return message;
  }

  private requireTenant(tenantId: string): void {
    if (tenantId !== this.tenantId) throw new Error('消息租户与仓储租户不一致');
  }

  private requiredDelivery(id: string): StoredDelivery {
    const delivery = this.getDeliveryById(id);
    if (!delivery) throw new Error(`消息投递不存在: ${id}`);
    return delivery;
  }

  private requiredAdapterState(adapterId: string): MessagingAdapterState {
    const state = this.getAdapterState(adapterId);
    if (!state) throw new Error(`消息适配器状态不存在: ${adapterId}`);
    return state;
  }
}

export class MessagingInboundIdentityConflictError extends Error {
  constructor(readonly providerMessageId: string) {
    super(`相同提供商消息标识对应不同载荷: ${providerMessageId}`);
  }
}

export class MessagingDeliveryIdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`投递幂等键对应不同请求: ${idempotencyKey}`);
  }
}

export class MessagingDeliveryVersionConflictError extends Error {
  constructor(readonly deliveryId: string, readonly expectedVersion: number) {
    super(`消息投递版本冲突: ${deliveryId} v${expectedVersion}`);
  }
}

export class MessagingInboundStateConflictError extends Error {
  constructor(readonly inboundId: string) {
    super(`消息入站状态冲突: ${inboundId}`);
  }
}

export class MessagingAdapterVersionConflictError extends Error {
  constructor(readonly adapterId: string, readonly expectedVersion: number) {
    super(`消息适配器版本冲突: ${adapterId} v${expectedVersion}`);
  }
}

function inboundFromRow(row: InboundRow): StoredInboundMessage {
  return {
    envelope: JSON.parse(row.envelope_json) as InboundMessageEnvelope,
    status: row.status,
    attempts: row.attempts,
    version: row.version,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.outcome_code ? { outcomeCode: row.outcome_code } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.processed_at ? { processedAt: row.processed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function storedDeliveryRequest(request: MessageDeliveryRequest): StoredMessageDeliveryRequest {
  return {
    tenantId: request.tenantId,
    adapterId: request.adapterId,
    channel: request.channel,
    idempotencyKey: request.idempotencyKey,
    ...(request.sender ? { sender: { ...request.sender } } : {}),
    recipients: request.recipients.map((recipient) => ({ ...recipient })),
    ...(request.subject !== undefined ? { subject: request.subject } : {}),
    text: request.text,
    attachments: request.attachments.map(({ content: _content, ...descriptor }) => ({ ...descriptor })),
    ...(request.thread ? { thread: {
      ...(request.thread.inReplyTo ? { inReplyTo: request.thread.inReplyTo } : {}),
      ...(request.thread.references ? { references: [...request.thread.references] } : {}),
    } } : {}),
    trace: { ...request.trace },
  };
}

function deliveryFromRow(row: DeliveryRow): StoredDelivery {
  return {
    id: row.id,
    request: JSON.parse(row.request_json) as StoredMessageDeliveryRequest,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    attempts: row.attempts,
    version: row.version,
    externalDispatchStarted: row.external_dispatch_started === 1,
    ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
    ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function adapterStateFromRow(row: AdapterStateRow): MessagingAdapterState {
  return {
    configured:row.configured===1,
    ...(row.started_at?{startedAt:row.started_at}:{}),
    tenantId: row.tenant_id,
    adapterId: row.adapter_id,
    channel: row.channel,
    provider: row.provider,
    status: row.status,
    capabilities: JSON.parse(row.capabilities_json) as MessagingAdapterState['capabilities'],
    consecutiveFailures: row.consecutive_failures,
    ...(row.failure_window_started_at ? { failureWindowStartedAt: row.failure_window_started_at } : {}),
    ...(row.last_health_at ? { lastHealthAt: row.last_health_at } : {}),
    ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.pause_reason ? { pauseReason: row.pause_reason } : {}),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeEventMetadata(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:body|text|content|attachment|credential|secret|password|prompt)/iu.test(key)) continue;
    if (Array.isArray(item)) {
      sanitized[key] = item.map((entry) => sanitizeEventValue(entry));
    } else {
      sanitized[key] = sanitizeEventValue(item);
    }
  }
  return sanitized;
}

function sanitizeEventValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Array.isArray(value)
      ? value.map((entry) => sanitizeEventValue(entry))
      : sanitizeEventMetadata(value as Readonly<Record<string, unknown>>);
  }
  return Buffer.isBuffer(value) ? '[已移除二进制内容]' : value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
