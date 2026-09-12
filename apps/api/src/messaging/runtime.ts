import type { DatabaseSync } from 'node:sqlite';
import { sendMail as sendMailThroughSmtp, type SendMailInput, type SendMailResult } from '@readywork/connectors';
import {
  MessageGateway,
  MessagingRepository,
  MessagingInboundStateConflictError,
  type InboundMessageEnvelope,
  type MessageDeliveryReceipt,
  type MessageDeliveryRequest,
  type MessageAttachmentPayload,
  type AdapterPollInput,
  type MessagingAdapterState,
  type StoredInboundMessage,
} from '@readywork/messaging';
import { EmailMessagingAdapter } from './email-adapter.js';
import { HermesMessagingAdapter, type HermesMessagingAdapterOptions } from './hermes-adapter.js';
import { HermesRepository } from './hermes-repository.js';
import type { EmailTransportMode } from './email-transport-mode.js';

export interface MessagingCredentialControl {
  listCredentials(): Array<{ id: string; connectorId: string; status: string }>;
  getCredential(id: string): Record<string, unknown> | undefined;
}

export interface MessagingRuntimeRegistryOptions {
  readonly now?: () => string;
  readonly sendMail?: (
    host: string,
    port: number,
    user: string,
    pass: string,
    mail: SendMailInput,
  ) => Promise<SendMailResult>;
  readonly hermesBridge?: Omit<HermesMessagingAdapterOptions, 'profile'>;
  readonly emailTransportMode?: EmailTransportMode;
}

export type MessagingInboundDispatchResult =
  | { readonly status: 'processed'; readonly communicationId?: string }
  | { readonly status: 'rejected'; readonly reasonCode: string }
  | { readonly status: 'retryable_failure'; readonly error: string };

export type MessagingInboundHandler = (message: StoredInboundMessage) => Promise<MessagingInboundDispatchResult>;

export interface MessagingInboundRunResult {
  readonly inboundId: string;
  readonly status: 'processed' | 'rejected' | 'failed' | 'dispatching';
  readonly replayed: boolean;
}

interface ResolvedEmailCredential {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly pass: string;
}

export class MessagingRuntimeRegistry {
  private readonly runtimes = new Map<string, MessagingRuntime>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly controlForTenant: (tenantId: string) => MessagingCredentialControl,
    private readonly options: MessagingRuntimeRegistryOptions = {},
  ) {}

  forTenant(tenantId: string): MessagingRuntime {
    let runtime = this.runtimes.get(tenantId);
    if (!runtime) {
      runtime = new MessagingRuntime(this.db, tenantId, this.controlForTenant(tenantId), this.options);
      this.runtimes.set(tenantId, runtime);
    }
    return runtime;
  }
}

export class MessagingRuntime {
  readonly repository: MessagingRepository;
  readonly gateway: MessageGateway;
  private readonly now: () => string;
  private readonly hermesProfile: string;
  private readonly hermesChannels = new Set<string>();

  constructor(
    db: DatabaseSync,
    readonly tenantId: string,
    private readonly control: MessagingCredentialControl,
    private readonly options: MessagingRuntimeRegistryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.hermesProfile = new HermesRepository(db, tenantId).profileForTenant(this.now());
    const sendMail = options.sendMail ?? sendMailThroughSmtp;
    this.repository = new MessagingRepository(db, tenantId);
    this.gateway = new MessageGateway(this.repository, { now: this.now });
    if (this.emailTransportMode === 'native') {
      this.gateway.register(new EmailMessagingAdapter(
        'email',
        'smtp',
        async (mail) => {
          const credential = this.resolveEmailCredential();
          if (!credential) {
            return {
              ok: false,
              message: 'Email 缺少当前租户已验证凭据',
              dispatchStage: 'before_dispatch',
              retryable: false,
            };
          }
          return sendMail(credential.host, credential.port, credential.user, credential.pass, mail);
        },
        {
          now: this.now,
          health: async () => {
            const state=this.repository.getAdapterState('email');
            return this.resolveEmailCredential() && state?.status==='running' && state.lastSuccessAt && Date.parse(this.now())-Date.parse(state.lastSuccessAt)<300_000
              ? {ok:true} : {ok:false,message:'尚无最近 SMTP 成功观测'};
          },
        },
      ));
      this.synchronizeEmailConfiguration();
    }
  }

  get emailTransportMode(): EmailTransportMode {
    return this.options.emailTransportMode ?? 'native';
  }

  async deliver(request: MessageDeliveryRequest): Promise<MessageDeliveryReceipt> {
    this.synchronizeEmailConfiguration();
    return this.gateway.deliver(request);
  }

  async ingest(
    envelope: InboundMessageEnvelope,
    attachments: readonly MessageAttachmentPayload[] = [],
  ): Promise<{ inboundId: string; replayed: boolean }> {
    return this.gateway.ingest(envelope, attachments);
  }

  async processInbound(
    envelope: InboundMessageEnvelope,
    handler: MessagingInboundHandler,
    attachments: readonly MessageAttachmentPayload[] = [],
  ): Promise<MessagingInboundRunResult> {
    const ingested = await this.gateway.ingest(envelope,attachments);
    const current = this.repository.listInbound({ limit: 500 })
      .find((message) => message.envelope.id === ingested.inboundId);
    if (current?.status === 'processed' || current?.status === 'rejected') {
      return { inboundId: ingested.inboundId, status: current.status, replayed: true };
    }
    const claimed = this.repository.claimInboundById(
      ingested.inboundId,
      `messaging-runtime:${process.pid}`,
      180_000,
      this.now(),
    );
    if (!claimed) {
      return { inboundId: ingested.inboundId, status: 'dispatching', replayed: ingested.replayed };
    }
    return this.dispatchClaimedInbound(claimed, handler, ingested.replayed);
  }

  synchronizeHermesPlatforms(platforms: ReadonlyArray<{
    readonly id: string;
    readonly enabled: boolean;
    readonly configured: boolean;
    readonly state: string;
  }>): void {
    if (!this.options.hermesBridge) return;
    for (const platform of platforms) {
      if (platform.id === 'readywork_bridge') continue;
      if (platform.id === 'email' && this.emailTransportMode === 'native') continue;
      const adapterId = platform.id === 'email' ? 'email' : `hermes:${platform.id}`;
      if (!this.hermesChannels.has(platform.id)) {
        this.gateway.register(new HermesMessagingAdapter(platform.id, {
          ...this.options.hermesBridge,
          profile: this.hermesProfile,
        }, adapterId));
        this.hermesChannels.add(platform.id);
      }
      const current = this.repository.getAdapterState(adapterId);
      if (!current || current.status === 'paused' || current.status === 'paused_by_breaker') continue;
      const status = !platform.enabled
        ? 'disabled'
        : !platform.configured
          ? 'unconfigured'
          : platform.state === 'connected'
            ? 'running'
            : 'degraded';
      this.repository.saveAdapterState({
        ...current,
        configured: platform.configured,
        status,
        lastHealthAt: this.now(),
        ...(status === 'running' ? { lastSuccessAt: this.now(), lastError: undefined } : {}),
        ...(status === 'degraded' ? { lastError: 'Hermes 渠道尚未报告已连接' } : {}),
        updatedAt: this.now(),
      }, current.version);
    }
  }

  async runPendingInbound(handler: MessagingInboundHandler, limit = 20): Promise<{
    claimed: number;
    processed: number;
    rejected: number;
    failed: number;
  }> {
    const candidates = this.repository.pendingInboundIds(limit,this.now());
    const summary = { claimed: 0, processed: 0, rejected: 0, failed: 0 };
    for (const candidate of candidates) {
      const message=this.repository.claimInboundById(candidate,`messaging-runtime:${process.pid}`,180_000,this.now());
      if (!message) continue;
      summary.claimed += 1;
      const result = await this.dispatchClaimedInbound(message, handler, true);
      summary[result.status === 'processed' ? 'processed' : result.status === 'rejected' ? 'rejected' : 'failed'] += 1;
    }
    return summary;
  }

  getAdapterState(adapterId: string): MessagingAdapterState {
    if (adapterId === 'email' && this.emailTransportMode === 'native') this.synchronizeEmailConfiguration();
    const state=this.gateway.getAdapterState(adapterId);
    if (state.status==='running' && (!state.lastSuccessAt || Date.parse(this.now())-Date.parse(state.lastSuccessAt)>=300_000)) {
      return this.repository.saveAdapterState({...state,status:'degraded',lastError:'最近协议健康观测已过期',updatedAt:this.now()},state.version);
    }
    return state;
  }

  adapterStates(): MessagingAdapterState[] {
    this.synchronizeEmailConfiguration();
    this.repository.recoverExpiredDeliveries(this.now());
    return this.repository.listAdapterStates().map(state=>this.getAdapterState(state.adapterId));
  }

  registerEmailReceiver(poll: (input: AdapterPollInput, signal: AbortSignal)=>Promise<{handledCount:number}>, configured: boolean): void {
    if (this.emailTransportMode !== 'native') return;
    this.gateway.register(new EmailMessagingAdapter('email-imap','imap',async()=>({ok:false,message:'仅接收协议',retryable:false}),{poll,now:this.now}));
    const state=this.gateway.getAdapterState('email-imap');
    this.repository.saveAdapterState({...state,configured,startedAt:this.now(),
      status:['paused','paused_by_breaker','disabled'].includes(state.status)?state.status:configured?'degraded':'unconfigured',updatedAt:this.now()},state.version);
  }

  pauseAdapter(adapterId: string, expectedVersion: number, actorId: string, reason: string): MessagingAdapterState {
    return this.gateway.pauseAdapter(adapterId, expectedVersion, actorId, reason);
  }

  resumeAdapter(adapterId: string, expectedVersion: number, actorId: string, reason: string): MessagingAdapterState {
    return this.gateway.resumeAdapter(adapterId, expectedVersion, actorId, reason);
  }

  private synchronizeEmailConfiguration(): void {
    if (this.emailTransportMode !== 'native') return;
    const configured = Boolean(this.resolveEmailCredential());
    const current = this.repository.getAdapterState('email');
    if (!current || current.status === 'paused' || current.status === 'paused_by_breaker' || current.status === 'disabled') return;
    const stale = !current.lastSuccessAt || Date.parse(this.now())-Date.parse(current.lastSuccessAt)>=300_000;
    const desired = configured ? (current.status === 'unconfigured' || (current.status==='running'&&stale) ? 'degraded' : current.status) : 'unconfigured';
    if (desired === current.status && current.configured===configured) return;
    this.repository.saveAdapterState({
      ...current,
      status: desired,
      configured,
      ...(configured ? { lastError: undefined } : { lastError: 'Email 缺少当前租户已验证凭据' }),
      updatedAt: this.now(),
    }, current.version);
  }

  private async dispatchClaimedInbound(
    message: StoredInboundMessage,
    handler: MessagingInboundHandler,
    replayed: boolean,
  ): Promise<MessagingInboundRunResult> {
    const renewal = setInterval(() => {
      try { this.repository.renewInboundLease(message,this.now(),180_000); } catch { /* Completion remains fenced if storage becomes unavailable. */ }
    },30_000);
    renewal.unref();
    try {
      const result = await handler(message);
      if (result.status === 'retryable_failure') {
        this.repository.failInbound(message.envelope.id, this.now(), result.error, message);
        return { inboundId: message.envelope.id, status: 'failed', replayed };
      }
      this.repository.completeInbound(
        message.envelope.id,
        result.status,
        this.now(),
        result.status === 'processed' ? result.communicationId ?? 'processed' : result.reasonCode,
        message,
      );
      return { inboundId: message.envelope.id, status: result.status, replayed };
    } catch (error) {
      if (error instanceof MessagingInboundStateConflictError) return {inboundId:message.envelope.id,status:'dispatching',replayed};
      try { this.repository.failInbound(message.envelope.id, this.now(), error, message); }
      catch (failure) { if (!(failure instanceof MessagingInboundStateConflictError)) throw failure; }
      return { inboundId: message.envelope.id, status: 'failed', replayed };
    } finally { clearInterval(renewal); }
  }

  private resolveEmailCredential(): ResolvedEmailCredential | undefined {
    const descriptor = this.control.listCredentials()
      .find((credential) => credential.connectorId === 'email' && credential.status === 'connected');
    const value = descriptor ? this.control.getCredential(descriptor.id) : undefined;
    if (!value) return undefined;
    const host = String(value['smtpHost'] ?? 'smtp.163.com').trim();
    const port = Number(value['smtpPort'] ?? 465);
    const user = String(value['username'] ?? value['user'] ?? '').trim();
    const pass = String(value['authorizationCode'] ?? value['password'] ?? value['pass'] ?? '');
    if (!host || !Number.isSafeInteger(port) || port <= 0 || port > 65_535 || !user || !pass) return undefined;
    return { host, port, user, pass };
  }
}
