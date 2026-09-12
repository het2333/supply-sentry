import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ConnectorExecutionContext, ConnectorExecutionResult } from '@readywork/connector-runtime';
import { OdooPurchaseOrderCancellationRejectedError, type OdooPurchaseOrderDraftInput } from '@readywork/connectors';
import type {
  ProcurementOutboxMessage,
  ProcurementOutboxAttachmentSnapshot,
  PurchaseOrder,
  PurchaseOrderLine,
  RequestForQuotation,
  RequestForQuotationLine,
  Supplier,
  SupplierInvoice,
} from '@readywork/core';
import { createProcurementRepository, type ProcurementRepository } from '@readywork/persistence';
import type { MessageDeliveryReceipt, MessageDeliveryRequest } from '@readywork/messaging';
import { redactSensitive } from './http-errors.js';
import type { AttachmentObjectStorage } from './attachment-object-storage.js';
import { loadProcurementAttachmentContent } from './procurement-attachment-content.js';
import { normalizeDraftRecipient } from './procurement-message-drafts.js';
import type { OdooRuntimeResolver, ResolvedOdooRuntime } from './odoo-runtime-resolver.js';

export interface OutboxConnectorPort {
  execute(connectorId: string, action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorExecutionResult>;
  listCredentials(): Array<{ id: string; connectorId: string; status: string }>;
  getCredential(id: string): Record<string, unknown> | undefined;
}

export interface ProcurementOutboxWorkerOptions {
  workerId?: string;
  leaseDurationMs?: number;
  batchSize?: number;
  maximumAttempts?: number;
  now?: () => Date;
  objectStorage?: AttachmentObjectStorage;
  /** Resolve ERP immediately after a lease is claimed, before external I/O. */
  odooRuntimeResolver?: Pick<OdooRuntimeResolver, 'resolve'>;
  /** Tenant-scoped channel gateway. Formal Email/WhatsApp delivery never calls ConnectorRegistry directly. */
  messageGatewayForTenant?: (tenantId: string) => MessageDeliveryPort;
}

export interface MessageDeliveryPort {
  deliver(request: MessageDeliveryRequest): Promise<MessageDeliveryReceipt>;
}

export interface ProcurementOutboxRunResult {
  claimed: number;
  dispatched: number;
  retryScheduled: number;
  failed: number;
}

/**
 * 持久化 Outbox 的唯一派发器。只有连接器返回真实成功后才调用 complete，
 * 由仓储在同一事务中推进 PO/发票事实；失败绝不会伪装成发送完成。
 */
export class ProcurementOutboxWorker {
  private readonly workerId: string;
  private readonly leaseDurationMs: number;
  private readonly batchSize: number;
  private readonly maximumAttempts: number;
  private readonly now: () => Date;
  private readonly objectStorage?: AttachmentObjectStorage;
  private readonly odooRuntimeResolver?: Pick<OdooRuntimeResolver, 'resolve'>;
  private readonly messageGatewayForTenant?: (tenantId: string) => MessageDeliveryPort;

  constructor(private db: DatabaseSync, private connectorsForTenant: (tenantId: string) => OutboxConnectorPort, options: ProcurementOutboxWorkerOptions = {}) {
    this.workerId = options.workerId ?? `procurement-outbox:${process.pid}`;
    this.leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.batchSize = options.batchSize ?? 10;
    this.maximumAttempts = options.maximumAttempts ?? 3;
    this.now = options.now ?? (() => new Date());
    this.objectStorage = options.objectStorage;
    this.odooRuntimeResolver = options.odooRuntimeResolver;
    this.messageGatewayForTenant = options.messageGatewayForTenant;
  }

  async runTenant(tenantId: string): Promise<ProcurementOutboxRunResult> {
    const repository = createProcurementRepository(this.db, tenantId);
    const connectors = this.connectorsForTenant(tenantId);
    const startedAt = this.now().toISOString();
    const readyConnectorIds = new Set(connectors.listCredentials()
      .filter((item) => item.status === 'connected' && connectors.getCredential(item.id) !== undefined)
      .map((item) => item.connectorId));
    for (const connectorId of readyConnectorIds) {
      repository.requeueBlockedOutboxMessages({ connectorId, requeuedAt: startedAt, limit: this.batchSize });
    }
    const claimed = repository.claimOutboxMessages({
      workerId: this.workerId, claimedAt: startedAt, leaseDurationMs: this.leaseDurationMs, limit: this.batchSize,
    });
    const summary: ProcurementOutboxRunResult = { claimed: claimed.length, dispatched: 0, retryScheduled: 0, failed: 0 };
    for (const message of claimed) {
      try {
        const { result, sentAttachments, externalDispatchStarted } = await this.dispatch(tenantId, repository, message, connectors);
        if (!result.ok) {
          const failure = new ConnectorDispatchError(result.error ?? '连接器执行失败');
          throw externalDispatchStarted ? new ExternalDispatchStartedError(failure) : failure;
        }
        const finishedAt = this.now();
        repository.completeOutboxMessage({
          id: message.id,
          leaseToken: requiredLeaseToken(message),
          completedAt: finishedAt.toISOString(),
          ...(sentAttachments ? { sentAttachments } : {}),
          ...(result.output && (message.channel === 'email' || message.channel === 'whatsapp') ? { connectorResult: {
            message_id: result.output['message_id'],
            accepted_at: result.output['accepted_at'] ?? result.output['sent_at'],
            delivery_status: result.output['delivery_status'] ?? (message.channel === 'email' ? 'sent' : undefined),
            from_name: result.output['from_name'],
          } } : result.output && (message.channel === 'erp' || message.action === 'purchase_order.create_draft') ? { connectorResult: result.output } : {}),
        });
        summary.dispatched += 1;
      } catch (error) {
        const finishedAt = this.now();
        if (error instanceof GatewayDeferredDispatchError) {
          repository.failOutboxMessage({id:message.id,leaseToken:requiredLeaseToken(message),failedAt:finishedAt.toISOString(),
            error:error.message,retryAt:error.nextAttemptAt,deferred:error.replayed});
          summary.retryScheduled += 1;
          continue;
        }
        const safe = redactSensitive(error, 500) || '外部派发失败';
        const amendmentDispatch = message.channel === 'erp' && (message.action === 'purchase_order.amend' || message.action === 'purchase_order.cancel');
        const externalDispatchStarted = error instanceof ExternalDispatchStartedError;
        const retry = !amendmentDispatch && message.attempts < this.maximumAttempts && isSafeBeforeDispatchFailure(error);
        repository.failOutboxMessage({
          id: message.id, leaseToken: requiredLeaseToken(message), failedAt: finishedAt.toISOString(), error: safe,
          uncertain: amendmentDispatch
            ? externalDispatchStarted
            : !isSafeBeforeDispatchFailure(error) && !(error instanceof ConfigurationDispatchError),
          ...(retry ? { retryAt: new Date(finishedAt.getTime() + retryDelayMs(message.attempts)).toISOString() } : {}),
        });
        if (retry) summary.retryScheduled += 1;
        else summary.failed += 1;
      }
    }
    return summary;
  }

  async runPendingTenants(): Promise<Record<string, ProcurementOutboxRunResult>> {
    const rows = this.db.prepare("SELECT DISTINCT tenant_id FROM procurement_outbox WHERE status IN ('pending','processing') ORDER BY tenant_id").all() as Array<{ tenant_id: string }>;
    const result: Record<string, ProcurementOutboxRunResult> = {};
    for (const row of rows) result[row.tenant_id] = await this.runTenant(row.tenant_id);
    return result;
  }

  private async dispatch(
    tenantId: string,
    repository: ProcurementRepository,
    message: ProcurementOutboxMessage,
    connectors: OutboxConnectorPort,
  ): Promise<{ result: ConnectorExecutionResult; sentAttachments?: readonly ProcurementOutboxAttachmentSnapshot[]; externalDispatchStarted?: boolean }> {
    if (message.tenantId !== tenantId) throw new ConfigurationDispatchError('outbox 消息租户与当前 worker 不一致');
    const resolved = await resolveConnectorAction(this.db, tenantId, repository, message, this.objectStorage);
    // Email is the first completed vertical slice. WhatsApp remains on its
    // existing real adapter until its own gateway adapter is registered.
    if (message.channel === 'email' && this.messageGatewayForTenant) {
      const receipt = await this.messageGatewayForTenant(tenantId).deliver(
        buildMessageDeliveryRequest(message, resolved),
      );
      if (receipt.status === 'deferred' || receipt.status === 'blocked') {
        throw new GatewayDeferredDispatchError(receipt.error ?? '等待消息渠道', receipt.nextAttemptAt!, receipt.replayed);
      }
      if (receipt.status === 'unknown') {
        throw new ExternalDispatchStartedError(receipt.error ?? '消息网关投递结果未知');
      }
      if (receipt.status === 'failed') {
        const error = receipt.error ?? '消息网关投递失败';
        if (receipt.retryable) throw new GatewayRetryableDispatchError(error);
        throw new ConfigurationDispatchError(error);
      }
      if (!receipt.providerMessageId || !receipt.acceptedAt) {
        throw new ExternalDispatchStartedError('消息网关 accepted 回执缺少 Message-ID 或接受时间');
      }
      return {
        result: { ok: true, output: {
          message_id: receipt.providerMessageId,
          accepted_at: receipt.acceptedAt,
          delivery_status: 'accepted',
          ...(typeof resolved.input['fromName'] === 'string' ? { from_name: resolved.input['fromName'] } : {}),
        } },
        ...(resolved.sentAttachments ? { sentAttachments: resolved.sentAttachments } : {}),
      };
    }
    // ERP uses the tenant-scoped resolver at lease-claim time.  The legacy
    // connector path remains for isolated worker tests and non-ERP channels.
    if (message.channel === 'erp' && this.odooRuntimeResolver) {
      const runtime = this.odooRuntimeResolver.resolve(tenantId);
      if (!runtime) throw new ConfigurationDispatchError('ERP 凭据未配置、未验证、已删除或无法解密');
      try {
        let result = await executeResolvedErpAction(runtime, resolved.action, resolved.input);
        if (message.action === 'purchase_order.create_draft' && result.ok) validateOdooDraftResult(result.output, resolved.input);
        if (message.action === 'purchase_order.update_rihd' && result.ok) {
          result = { ...result, output: normalizeOdooRihdResult(result.output, resolved.input) };
        }
        if (message.action === 'purchase_order.amend' && result.ok) {
          result = { ...result, output: normalizeOdooPurchaseOrderAmendmentResult(result.output, resolved.input) };
        }
        if (message.action === 'purchase_order.cancel' && result.ok) {
          result = { ...result, output: normalizeOdooPurchaseOrderCancellationResult(result.output, resolved.input) };
        }
        return { result, ...(resolved.sentAttachments ? { sentAttachments: resolved.sentAttachments } : {}), ...((message.action === 'purchase_order.amend' || message.action === 'purchase_order.cancel') ? { externalDispatchStarted: true } : {}) };
      } catch (error) {
        if (message.action === 'purchase_order.cancel' && error instanceof OdooPurchaseOrderCancellationRejectedError) throw error;
        if (message.action === 'purchase_order.amend' || message.action === 'purchase_order.cancel') throw new ExternalDispatchStartedError(error);
        throw error;
      }
    }
    const pinnedCredentialId = typeof message.payload['credentialId'] === 'string' ? message.payload['credentialId'].trim() : '';
    const credential = pinnedCredentialId
      ? connectors.listCredentials().find((item) => item.id === pinnedCredentialId && item.connectorId === message.connectorId && item.status === 'connected')
      : connectors.listCredentials().find((item) => item.connectorId === message.connectorId && item.status === 'connected');
    const credentials = credential ? connectors.getCredential(credential.id) : undefined;
    if (!credential || !credentials) throw new ConfigurationDispatchError(pinnedCredentialId
      ? `${message.connectorId} 已冻结连接凭据不可用`
      : `${message.connectorId} 连接凭据未配置或未验证`);
    const context: ConnectorExecutionContext = {
      tenantId: message.tenantId, employeeId: 'ai:procurement', runId: `outbox:${message.id}`,
      nodeRunId: `outbox:${message.id}:${message.attempts}`, idempotencyKey: message.idempotencyKey,
      credentials, timeoutMs: Math.max(1_000, this.leaseDurationMs - 5_000),
    };
    try {
      let result = await connectors.execute(message.connectorId, resolved.action, resolved.input, context);
      if (message.action === 'purchase_order.create_draft' && result.ok) validateOdooDraftResult(result.output, resolved.input);
      if (message.action === 'purchase_order.update_rihd' && result.ok) {
        result = { ...result, output: normalizeOdooRihdResult(result.output, resolved.input) };
      }
      if (message.action === 'purchase_order.amend' && result.ok) {
        result = { ...result, output: normalizeOdooPurchaseOrderAmendmentResult(result.output, resolved.input) };
      }
      if (message.action === 'purchase_order.cancel' && result.ok) {
        result = { ...result, output: normalizeOdooPurchaseOrderCancellationResult(result.output, resolved.input) };
      }
      return {
        result,
        ...(resolved.sentAttachments ? { sentAttachments: resolved.sentAttachments } : {}),
        ...((message.action === 'purchase_order.amend' || message.action === 'purchase_order.cancel') ? { externalDispatchStarted: true } : {}),
      };
    } catch (error) {
      if (message.action === 'purchase_order.cancel' && error instanceof OdooPurchaseOrderCancellationRejectedError) throw error;
      if (message.action === 'purchase_order.amend' || message.action === 'purchase_order.cancel') throw new ExternalDispatchStartedError(error);
      throw error;
    }
  }
}

async function executeResolvedErpAction(runtime: ResolvedOdooRuntime, action: string, input: Record<string, unknown>): Promise<ConnectorExecutionResult> {
  if (action === 'po.create_draft') {
    const draft = await runtime.client.createPurchaseOrderDraft(odooDraftInput(input));
    return { ok: true, output: {
      id: draft.id, name: draft.name, state: draft.state, correlationKey: String(input['correlationKey']), replayed: draft.replayed,
      credential: runtime.credential,
    } };
  }
  if (action === 'invoice.update') {
    const invoiceId = Number(input['invoiceId'] ?? input['id']);
    if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) throw new ConfigurationDispatchError('发票 ID 必须是正整数');
    const invoice = await runtime.client.updateInvoiceMatch(invoiceId, odooInvoiceUpdate(input));
    return { ok: true, output: { invoice: { id: invoice.id, name: invoice.name }, credential: runtime.credential } };
  }
  if (action === 'po.update') {
    const poName = frozenText(input['poId'], 'poId');
    const requiredInHouseAt = frozenText(input['value'], 'value');
    const write = await runtime.client.updateETA(poName, requiredInHouseAt);
    const po = await runtime.client.readPO(poName);
    const output = normalizeOdooRihdResult({ po, write, credential: runtime.credential }, input);
    return { ok: true, output };
  }
  if (action === 'po.amend') {
    const amendment = odooPurchaseOrderAmendmentInput(input);
    const write = amendment.patch['requiredInHouseAt'] === undefined
      ? undefined
      : await runtime.client.updateETA(amendment.poNumber, String(amendment.patch['requiredInHouseAt']));
    const po = await runtime.client.readPO(amendment.poNumber);
    return { ok: true, output: { po, ...(write ? { write } : {}), credential: runtime.credential } };
  }
  if (action === 'po.cancel') {
    const cancellation = odooPurchaseOrderCancellationInput(input);
    const result = await runtime.client.cancelPurchaseOrder(cancellation.poNumber);
    return { ok: true, output: { ...result, credential: runtime.credential } };
  }
  throw new ConfigurationDispatchError(`ERP Outbox 不支持动作: ${action}`);
}

function odooDraftInput(input: Record<string, unknown>): OdooPurchaseOrderDraftInput {
  const correlationKey = frozenText(input['correlationKey'], 'correlationKey');
  const partnerId = input['partnerId'];
  if (!(typeof partnerId === 'number' && Number.isSafeInteger(partnerId) && partnerId > 0) && !(typeof partnerId === 'string' && /^odoo-\d+$/.test(partnerId))) {
    throw new ConfigurationDispatchError('partnerId 无效');
  }
  const currencyCode = frozenText(input['currencyCode'], 'currencyCode');
  if (!Array.isArray(input['lines']) || input['lines'].length === 0) throw new ConfigurationDispatchError('Odoo 草稿至少需要一行');
  const lines = input['lines'].map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigurationDispatchError(`lines[${index}] 无效`);
    const line = raw as Record<string, unknown>;
    const quantity = Number(line['quantity']); const priceUnit = Number(line['priceUnit']);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(priceUnit) || priceUnit < 0) throw new ConfigurationDispatchError(`lines[${index}] 数量或价格无效`);
    return {
      itemCode: frozenText(line['itemCode'], `lines[${index}].itemCode`), quantity, priceUnit,
      ...(typeof line['description'] === 'string' && line['description'].trim() ? { description: line['description'].trim() } : {}),
      ...(typeof line['datePlanned'] === 'string' && line['datePlanned'].trim() ? { datePlanned: line['datePlanned'].trim() } : {}),
    };
  });
  return { correlationKey, partnerId, currencyCode, lines };
}

function odooInvoiceUpdate(input: Record<string, unknown>): { matchResult?: 'exact_match' | 'within_tolerance' | 'approval_required' | 'severe_exception'; approvalStatus?: 'pending' | 'approved' | 'rejected'; payableStatus?: 'payable' | 'hold' | 'not_payable'; holdReason?: string } {
  const result = input['matchResult']; const approval = input['approvalStatus']; const payable = input['payableStatus']; const holdReason = input['holdReason'];
  if (result !== undefined && (typeof result !== 'string' || !['exact_match', 'within_tolerance', 'approval_required', 'severe_exception'].includes(result))) throw new ConfigurationDispatchError('invoice.update matchResult 无效');
  if (approval !== undefined && (typeof approval !== 'string' || !['pending', 'approved', 'rejected'].includes(approval))) throw new ConfigurationDispatchError('invoice.update approvalStatus 无效');
  if (payable !== undefined && (typeof payable !== 'string' || !['payable', 'hold', 'not_payable'].includes(payable))) throw new ConfigurationDispatchError('invoice.update payableStatus 无效');
  if (holdReason !== undefined && (typeof holdReason !== 'string' || !holdReason.trim() || holdReason.length > 500)) throw new ConfigurationDispatchError('invoice.update holdReason 无效');
  const update = {
    ...(typeof result === 'string' ? { matchResult: result as 'exact_match' | 'within_tolerance' | 'approval_required' | 'severe_exception' } : {}),
    ...(typeof approval === 'string' ? { approvalStatus: approval as 'pending' | 'approved' | 'rejected' } : {}),
    ...(typeof payable === 'string' ? { payableStatus: payable as 'payable' | 'hold' | 'not_payable' } : {}),
    ...(typeof holdReason === 'string' ? { holdReason } : {}),
  };
  if (Object.keys(update).length === 0) throw new ConfigurationDispatchError('invoice.update 至少需要一个状态字段');
  return update;
}

function validateOdooDraftResult(output: Record<string, unknown> | undefined, input: Record<string, unknown>): void {
  if (!output) throw new ConfigurationDispatchError('Odoo 草稿回执不能为空');
  frozenPositiveInteger(output['id'], 'connectorResult.id');
  frozenText(output['name'], 'connectorResult.name');
  if (output['state'] !== 'draft') throw new ConfigurationDispatchError('connectorResult.state 必须为 draft');
  if (output['correlationKey'] !== input['correlationKey']) throw new ConfigurationDispatchError('connectorResult.correlationKey 与冻结值不一致');
  if (typeof output['replayed'] !== 'boolean') throw new ConfigurationDispatchError('connectorResult.replayed 必须是布尔值');
}

interface ResolvedConnectorAction {
  action: string;
  input: Record<string, unknown>;
  sentAttachments?: readonly ProcurementOutboxAttachmentSnapshot[];
}

function buildMessageDeliveryRequest(
  message: ProcurementOutboxMessage,
  resolved: ResolvedConnectorAction,
): MessageDeliveryRequest {
  if (message.channel !== 'email' && message.channel !== 'whatsapp') {
    throw new ConfigurationDispatchError(`消息网关不支持采购渠道: ${message.channel}`);
  }
  const to = frozenText(resolved.input['to'], '消息网关收件人');
  const rawAttachments = Array.isArray(resolved.input['attachments']) ? resolved.input['attachments'] : [];
  const attachments = rawAttachments.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigurationDispatchError(`消息附件 ${index + 1} 无效`);
    const record = raw as Record<string, unknown>;
    const contentValue = record['content'];
    if (!Buffer.isBuffer(contentValue) && !(contentValue instanceof Uint8Array)) {
      throw new ConfigurationDispatchError(`消息附件 ${index + 1} 缺少二进制内容`);
    }
    const content = Buffer.from(contentValue);
    const snapshot = resolved.sentAttachments?.[index];
    const sha256 = createHash('sha256').update(content).digest('hex');
    if (snapshot && snapshot.sha256 !== sha256) throw new ConfigurationDispatchError(`消息附件 ${index + 1} 摘要与冻结快照不一致`);
    return {
      id: snapshot?.id ?? `messaging-attachment:${sha256}`,
      name: frozenText(record['filename'], `消息附件 ${index + 1} 文件名`),
      contentType: frozenText(record['contentType'], `消息附件 ${index + 1} 类型`),
      sizeBytes: content.byteLength,
      sha256,
      content,
    };
  });
  const references = Array.isArray(resolved.input['references'])
    ? resolved.input['references'].map((value) => String(value)).filter(Boolean)
    : [];
  const inReplyTo = typeof resolved.input['inReplyTo'] === 'string' && resolved.input['inReplyTo'].trim()
    ? resolved.input['inReplyTo'].trim()
    : undefined;
  return {
    tenantId: message.tenantId,
    adapterId: message.connectorId,
    channel: message.channel,
    idempotencyKey: message.idempotencyKey,
    ...(typeof resolved.input['fromName'] === 'string' && resolved.input['fromName'].trim()
      ? { sender: { displayName: resolved.input['fromName'].trim() } }
      : {}),
    recipients: [{ address: to }],
    ...(typeof resolved.input['subject'] === 'string' ? { subject: resolved.input['subject'] } : {}),
    text: String(message.channel === 'email' ? resolved.input['body'] ?? '' : resolved.input['message'] ?? ''),
    attachments,
    ...((inReplyTo || references.length > 0) ? { thread: {
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(references.length > 0 ? { references } : {}),
    } } : {}),
    trace: {
      source: 'procurement_outbox',
      sourceId: message.id,
      correlationId: message.aggregateId,
    },
  };
}

async function resolveConnectorAction(
  db: DatabaseSync,
  tenantId: string,
  repository: ProcurementRepository,
  message: ProcurementOutboxMessage,
  objectStorage?: AttachmentObjectStorage,
): Promise<ResolvedConnectorAction> {
  if (message.channel === 'email') {
    if (message.action === 'purchase_order.draft_email.send') {
      const draftId = typeof message.payload['draftId'] === 'string' ? message.payload['draftId'].trim() : '';
      if (!draftId) throw new ConfigurationDispatchError('待发送邮件草稿 ID 无效');
      const draft = db.prepare(`SELECT purchase_order_id,supplier_id,recipient,subject,body,status,outbox_id,sender_name,sender_title,sender_organization
        FROM procurement_message_drafts WHERE tenant_id=? AND id=?`).get(tenantId, draftId) as {
          purchase_order_id: string; supplier_id: string; recipient: string; subject: string; body: string;
          status: string; outbox_id: string | null; sender_name: string | null; sender_title: string | null; sender_organization: string | null;
        } | undefined;
      if (!draft) throw new ConfigurationDispatchError('待发送邮件草稿不存在');
      if (draft.status !== 'approved_queued' || draft.outbox_id !== message.id) {
        throw new ConfigurationDispatchError('邮件草稿未批准或与当前 outbox 不匹配');
      }
      const po = repository.getDocument<PurchaseOrder>('purchase_order', draft.purchase_order_id)?.document;
      if (!po || po.supplierId !== draft.supplier_id) throw new ConfigurationDispatchError('邮件草稿关联的采购订单或供应商无效');
      let recipient: string;
      try { recipient = normalizeDraftRecipient('email', draft.recipient); }
      catch (error) { throw new ConfigurationDispatchError(error instanceof Error ? error.message : '邮件草稿收件人无效'); }
      const identity = identityFromDraft(draft);
      return {
        action: 'send',
        input: {
          to: recipient,
          subject: draft.subject,
          body: draft.body,
          fromName: identity.displayName,
          businessObjectId: po.id,
          supplierId: po.supplierId,
        },
      };
    }
    if (message.action === 'rfq.send') {
      const identity = frozenCommunicationIdentity(message.payload['communicationIdentity']);
      const rfq = repository.getDocument<RequestForQuotation>('rfq', message.aggregateId)?.document;
      if (!rfq) throw new ConfigurationDispatchError('待发送 RFQ 不存在');
      const supplierId = String(message.payload['supplierId'] ?? '');
      if (!supplierId || !rfq.supplierIds.includes(supplierId)) throw new ConfigurationDispatchError('RFQ 待发送供应商无效');
      const supplier = repository.getDocument<Supplier>('supplier', supplierId)?.document;
      const contact = supplier?.contacts.find((item) => item.primary && item.email) ?? supplier?.contacts.find((item) => item.email);
      if (!contact?.email) throw new ConfigurationDispatchError('供应商未配置可发信联系人');
      const lines = repository.listLines<RequestForQuotationLine>('rfq_line', rfq.id);
      const lineText = lines.map((line) => `${line.lineNumber}. ${line.itemName ?? line.description ?? line.itemId} × ${line.requestedQty} ${line.uom}，目标日期 ${line.requiredAt?.slice(0, 10) ?? '待确认'}`).join('\n');
      const subject = `询价 ${rfq.externalId} | ${rfq.title ?? rfq.id}`;
      const body = `您好，\n\n请对以下采购需求报价：\n${lineText}\n\n币种：${rfq.currency}\n报价截止：${rfq.quoteDueAt.slice(0, 10)}\n\n请直接回复本邮件，并逐行提供：含/未税单价、数量、MOQ、交期、付款条件、有效期及其他费用。\n\n${professionalSignature(identity)}`;
      const sentAttachments = parseAttachmentSnapshots(message.payload['attachments']);
      const attachments = await loadVerifiedAttachments(db, tenantId, sentAttachments, objectStorage);
      return {
        action: 'send',
        input: {
          to: contact.email,
          subject,
          body,
          fromName: identity.displayName,
          businessObjectId: rfq.id,
          supplierId,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        sentAttachments,
      };
    }
    const identity = frozenCommunicationIdentity(message.payload['communicationIdentity']);
    const storedPo = repository.getDocument<PurchaseOrder>('purchase_order', message.aggregateId);
    if (!storedPo) throw new ConfigurationDispatchError('待发送采购订单不存在');
    const po = storedPo.document;
    const frozenPoVersion = Number(message.payload['poVersion']);
    if (!Number.isSafeInteger(frozenPoVersion) || frozenPoVersion <= 0 || storedPo.version !== frozenPoVersion) {
      throw new ConfigurationDispatchError('PO 版本与入队时冻结快照不一致，已阻止发送');
    }
    const supplier = repository.getDocument<Supplier>('supplier', po.supplierId)?.document;
    const contact = supplier?.contacts.find((item) => item.primary && item.email) ?? supplier?.contacts.find((item) => item.email);
    if (!contact?.email) throw new ConfigurationDispatchError('供应商未配置可发信联系人');
    const lines = repository.listLines<PurchaseOrderLine>('purchase_order_line', po.id);
    const subject = message.action === 'purchase_order.followup' ? `采购订单催交 ${po.externalId}` : `采购订单 ${po.externalId}`;
    const body = message.action === 'purchase_order.followup'
      ? `请确认采购订单 ${po.externalId} 的生产、发货和预计到货状态。\n跟进原因：${String(message.payload['reason'] ?? '交付跟进')}\n\n${professionalSignature(identity)}`
      : `请确认采购订单 ${po.externalId}。\n行数：${lines.length}\n币种：${po.currency}\n${lines.map((line) => `${line.lineNumber}. ${line.description || line.itemId}：${line.orderedQty} ${line.uom}，单价 ${line.unitPrice} ${po.currency}`).join('\n')}\n\n请直接用普通文字回复各行物料、确认数量、单价（含币种）与承诺交期（含年份），无需填写代码或固定格式。如有差异请明确说明。\n\n${professionalSignature(identity)}`;
    const sentAttachments = parseAttachmentSnapshots(message.payload['attachments']);
    const attachments = await loadVerifiedAttachments(db, tenantId, sentAttachments, objectStorage);
    return {
      action: 'send',
      input: { to: contact.email, subject, body, fromName: identity.displayName, businessObjectId: po.id, supplierId: po.supplierId,
        ...(attachments.length > 0 ? { attachments } : {}) },
      sentAttachments,
    };
  }
  if (message.channel === 'whatsapp' && message.action === 'purchase_order.draft_whatsapp.send') {
    const draftId = typeof message.payload['draftId'] === 'string' ? message.payload['draftId'].trim() : '';
    if (!draftId) throw new ConfigurationDispatchError('待发送 WhatsApp 草稿 ID 无效');
    const draft = db.prepare(`SELECT purchase_order_id,supplier_id,channel,recipient,subject,body,status,outbox_id
      FROM procurement_message_drafts WHERE tenant_id=? AND id=?`).get(tenantId, draftId) as {
        purchase_order_id: string; supplier_id: string; channel: string; recipient: string; subject: string; body: string;
        status: string; outbox_id: string | null;
      } | undefined;
    if (!draft) throw new ConfigurationDispatchError('待发送 WhatsApp 草稿不存在');
    if (draft.channel !== 'whatsapp' || draft.status !== 'approved_queued' || draft.outbox_id !== message.id) {
      throw new ConfigurationDispatchError('WhatsApp 草稿未批准或与当前 outbox 不匹配');
    }
    const po = repository.getDocument<PurchaseOrder>('purchase_order', draft.purchase_order_id)?.document;
    if (!po || po.supplierId !== draft.supplier_id) throw new ConfigurationDispatchError('WhatsApp 草稿关联的采购订单或供应商无效');
    const supplier = repository.getDocument<Supplier>('supplier', po.supplierId)?.document;
    let recipient: string;
    try { recipient = normalizeDraftRecipient('whatsapp', draft.recipient); }
    catch (error) { throw new ConfigurationDispatchError(error instanceof Error ? error.message : 'WhatsApp 收件号码无效'); }
    return { action: 'send_template', input: {
      to: recipient,
      poNumber: po.externalId || po.id,
      supplierName: supplier?.name ?? po.supplierId,
      message: draft.body,
      businessObjectId: po.id,
      supplierId: po.supplierId,
    } };
  }
  if (message.channel === 'erp' && message.action === 'purchase_order.create_draft') {
    return { action: 'po.create_draft', input: frozenOdooPurchaseOrderDraft(message) };
  }
  if (message.channel === 'erp' && message.action === 'purchase_order.update_rihd') {
    return { action: 'po.update', input: frozenOdooRihdUpdate(message) };
  }
  if (message.channel === 'erp' && message.action === 'purchase_order.amend') {
    return { action: 'po.amend', input: frozenOdooPurchaseOrderAmendment(message) };
  }
  if (message.channel === 'erp' && message.action === 'purchase_order.cancel') {
    return { action: 'po.cancel', input: frozenOdooPurchaseOrderCancellation(message) };
  }
  if (message.channel === 'erp' && message.action === 'invoice.update') {
    const invoice = repository.getDocument<SupplierInvoice>('invoice', message.aggregateId)?.document;
    if (!invoice) throw new ConfigurationDispatchError('待回写发票不存在');
    if (invoice.sourceSystem !== 'odoo' || !/^[1-9]\d*$/.test(invoice.externalId)) {
      throw new ConfigurationDispatchError('发票没有可回写的 Odoo 整数外部 ID');
    }
    return { action: 'invoice.update', input: { invoiceId: Number(invoice.externalId), approvalStatus: 'approved', payableStatus: 'payable' } };
  }
  throw new ConfigurationDispatchError(`不支持的 outbox 动作: ${message.channel}.${message.action}`);
}

function frozenOdooPurchaseOrderDraft(message: ProcurementOutboxMessage): Record<string, unknown> {
  const poId = frozenText(message.payload['poId'], 'outbox.payload.poId');
  const poVersion = frozenPositiveInteger(message.payload['poVersion'], 'outbox.payload.poVersion');
  const correlationKey = frozenText(message.payload['correlationKey'], 'outbox.payload.correlationKey');
  const partnerId = frozenPositiveInteger(message.payload['partnerId'], 'outbox.payload.partnerId');
  const currencyCode = frozenText(message.payload['currency'], 'outbox.payload.currency').toUpperCase();
  const supplierMapping = frozenRecord(message.payload['supplierMapping'], 'outbox.payload.supplierMapping');
  if (frozenPositiveInteger(supplierMapping['partnerId'], 'outbox.payload.supplierMapping.partnerId') !== partnerId
    || frozenText(supplierMapping['sourceSystem'], 'outbox.payload.supplierMapping.sourceSystem') !== 'odoo') {
    throw new ConfigurationDispatchError('Odoo 供应商冻结映射不一致');
  }
  const rawLines = message.payload['lines'];
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw new ConfigurationDispatchError('Odoo 草稿冻结采购行不能为空');
  const lines = rawLines.map((raw, index) => {
    const line = frozenRecord(raw, `outbox.payload.lines[${index}]`);
    const itemCode = frozenText(line['itemId'], `outbox.payload.lines[${index}].itemId`);
    const quantity = frozenPositiveNumber(line['qty'], `outbox.payload.lines[${index}].qty`);
    const priceUnit = frozenNonNegativeNumber(line['unitPrice'], `outbox.payload.lines[${index}].unitPrice`);
    const description = frozenText(line['description'], `outbox.payload.lines[${index}].description`);
    const datePlanned = frozenText(line['requestedAt'], `outbox.payload.lines[${index}].requestedAt`);
    if (frozenText(line['currency'], `outbox.payload.lines[${index}].currency`).toUpperCase() !== currencyCode) {
      throw new ConfigurationDispatchError(`Odoo 草稿冻结采购行 ${index + 1} 币种不一致`);
    }
    return { itemCode, quantity, priceUnit, description, datePlanned };
  });
  return { poId, poVersion, correlationKey, partnerId, currencyCode, lines };
}

function frozenOdooRihdUpdate(message: ProcurementOutboxMessage): Record<string, unknown> {
  const poId = frozenText(message.payload['poId'], 'outbox.payload.poId');
  const poVersion = frozenPositiveInteger(message.payload['poVersion'], 'outbox.payload.poVersion');
  const requiredInHouseAt = frozenText(message.payload['requiredInHouseAt'], 'outbox.payload.requiredInHouseAt');
  if (!Number.isFinite(Date.parse(requiredInHouseAt))) throw new ConfigurationDispatchError('outbox.payload.requiredInHouseAt 必须是有效日期');
  const mapping = frozenRecord(message.payload['odooMapping'], 'outbox.payload.odooMapping');
  const poName = frozenText(mapping['poNumber'], 'outbox.payload.odooMapping.poNumber');
  frozenPositiveInteger(mapping['odooId'], 'outbox.payload.odooMapping.odooId');
  const lines = message.payload['lines'];
  if (!Array.isArray(lines) || lines.length === 0) throw new ConfigurationDispatchError('outbox.payload.lines 必须是非空行快照');
  const lineIds = new Set<string>();
  for (const [index, raw] of lines.entries()) {
    const line = frozenRecord(raw, `outbox.payload.lines[${index}]`);
    const lineId = frozenText(line['poLineId'], `outbox.payload.lines[${index}].poLineId`);
    if (lineIds.has(lineId)) throw new ConfigurationDispatchError('outbox.payload.lines.poLineId 不能重复');
    lineIds.add(lineId);
    frozenText(line['lineNumber'], `outbox.payload.lines[${index}].lineNumber`);
    frozenPositiveNumber(line['orderedQty'], `outbox.payload.lines[${index}].orderedQty`);
    if (line['requestedAt'] !== null) frozenText(line['requestedAt'], `outbox.payload.lines[${index}].requestedAt`);
  }
  return {
    businessObjectId: poId,
    poVersion,
    poId: poName,
    field: 'date_planned',
    value: requiredInHouseAt,
    expectedLineCount: lines.length,
  };
}

function frozenOdooPurchaseOrderAmendment(message: ProcurementOutboxMessage): Record<string, unknown> {
  const amendmentId = frozenText(message.payload['amendmentId'], 'outbox.payload.amendmentId');
  const poId = frozenText(message.payload['poId'], 'outbox.payload.poId');
  if (poId !== message.aggregateId) throw new ConfigurationDispatchError('Odoo amendment 冻结 PO 与 outbox 聚合不一致');
  const sourcePoVersion = frozenPositiveInteger(message.payload['sourcePoVersion'], 'outbox.payload.sourcePoVersion');
  const mapping = frozenRecord(message.payload['odooMapping'], 'outbox.payload.odooMapping');
  const sourceSystem = frozenText(mapping['sourceSystem'], 'outbox.payload.odooMapping.sourceSystem');
  if (sourceSystem !== 'odoo' && sourceSystem !== 'readywork') throw new ConfigurationDispatchError('Odoo amendment 来源映射无效');
  frozenText(mapping['externalId'], 'outbox.payload.odooMapping.externalId');
  const odooId = frozenPositiveInteger(mapping['odooId'], 'outbox.payload.odooMapping.odooId');
  const poNumber = frozenText(mapping['poNumber'], 'outbox.payload.odooMapping.poNumber');
  const patch = frozenOdooPurchaseOrderAmendmentPatch(message.payload['patch']);
  frozenText(message.payload['reason'], 'outbox.payload.reason');
  frozenText(message.payload['actorId'], 'outbox.payload.actorId');
  return { amendmentId, poId, sourcePoVersion, odooId, poNumber, patch };
}

function frozenOdooPurchaseOrderCancellation(message: ProcurementOutboxMessage): Record<string, unknown> {
  const amendmentId = frozenText(message.payload['amendmentId'], 'outbox.payload.amendmentId');
  const poId = frozenText(message.payload['poId'], 'outbox.payload.poId');
  if (poId !== message.aggregateId) throw new ConfigurationDispatchError('Odoo cancellation 冻结 PO 与 outbox 聚合不一致');
  const sourcePoVersion = frozenPositiveInteger(message.payload['sourcePoVersion'], 'outbox.payload.sourcePoVersion');
  const mapping = frozenRecord(message.payload['odooMapping'], 'outbox.payload.odooMapping');
  const sourceSystem = frozenText(mapping['sourceSystem'], 'outbox.payload.odooMapping.sourceSystem');
  if (sourceSystem !== 'odoo' && sourceSystem !== 'readywork') throw new ConfigurationDispatchError('Odoo cancellation 来源映射无效');
  frozenText(mapping['externalId'], 'outbox.payload.odooMapping.externalId');
  const odooId = frozenPositiveInteger(mapping['odooId'], 'outbox.payload.odooMapping.odooId');
  const poNumber = frozenText(mapping['poNumber'], 'outbox.payload.odooMapping.poNumber');
  frozenText(message.payload['reason'], 'outbox.payload.reason');
  frozenText(message.payload['actorId'], 'outbox.payload.actorId');
  return { amendmentId, poId, sourcePoVersion, odooId, poNumber };
}

function odooPurchaseOrderCancellationInput(input: Record<string, unknown>): { poNumber: string; odooId: number } {
  return {
    poNumber: frozenText(input['poNumber'], 'poNumber'),
    odooId: frozenPositiveInteger(input['odooId'], 'odooId'),
  };
}

function normalizeOdooPurchaseOrderCancellationResult(
  output: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!output) throw new Error('Odoo cancellation 写入回执为空');
  const expectedPoName = frozenText(input['poNumber'], 'poNumber');
  const expectedOdooId = frozenPositiveInteger(input['odooId'], 'odooId');
  const id = frozenPositiveInteger(output['id'], 'connectorResult.id');
  const name = frozenText(output['name'], 'connectorResult.name');
  const state = frozenText(output['state'], 'connectorResult.state');
  if (id !== expectedOdooId || name !== expectedPoName) throw new Error('Odoo cancellation 写后读取的采购订单不一致');
  const credential = output['credential'];
  return {
    po_name: expectedPoName,
    readbackMatches: state === 'cancel',
    receiptReference: `purchase.order:${expectedOdooId}`,
    ...(credential ? { credential } : {}),
  };
}

function frozenOdooPurchaseOrderAmendmentPatch(value: unknown): Record<string, unknown> {
  const raw = frozenRecord(value, 'outbox.payload.patch');
  const allowed = new Set(['supplierId', 'requiredInHouseAt', 'materialType', 'contactId', 'lines']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new ConfigurationDispatchError(`outbox.payload.patch 不支持字段: ${key}`);
  if (Object.keys(raw).length === 0) throw new ConfigurationDispatchError('outbox.payload.patch 不能为空');
  const patch: Record<string, unknown> = {};
  if (raw['supplierId'] !== undefined) patch['supplierId'] = frozenText(raw['supplierId'], 'outbox.payload.patch.supplierId');
  if (raw['requiredInHouseAt'] !== undefined) {
    const requiredInHouseAt = frozenText(raw['requiredInHouseAt'], 'outbox.payload.patch.requiredInHouseAt');
    if (!Number.isFinite(Date.parse(requiredInHouseAt))) throw new ConfigurationDispatchError('outbox.payload.patch.requiredInHouseAt 必须是有效日期');
    patch['requiredInHouseAt'] = requiredInHouseAt;
  }
  if (raw['materialType'] !== undefined) {
    if (raw['materialType'] !== 'direct' && raw['materialType'] !== 'indirect') throw new ConfigurationDispatchError('outbox.payload.patch.materialType 无效');
    patch['materialType'] = raw['materialType'];
  }
  if (raw['contactId'] !== undefined) {
    if (raw['contactId'] !== null) patch['contactId'] = frozenText(raw['contactId'], 'outbox.payload.patch.contactId');
    else patch['contactId'] = null;
  }
  if (raw['lines'] !== undefined) {
    if (!Array.isArray(raw['lines']) || raw['lines'].length === 0) throw new ConfigurationDispatchError('outbox.payload.patch.lines 必须是非空数组');
    patch['lines'] = raw['lines'].map((value, index) => {
      const line = frozenRecord(value, `outbox.payload.patch.lines[${index}]`);
      const quantity = line['quantity']; const unitPrice = line['unitPrice']; const taxRate = line['taxRate'];
      if (!Number.isFinite(quantity) || Number(quantity) <= 0) throw new ConfigurationDispatchError(`outbox.payload.patch.lines[${index}].quantity 无效`);
      if (unitPrice !== null && (!Number.isFinite(unitPrice) || Number(unitPrice) < 0)) throw new ConfigurationDispatchError(`outbox.payload.patch.lines[${index}].unitPrice 无效`);
      if (taxRate !== null && (!Number.isFinite(taxRate) || Number(taxRate) < 0 || Number(taxRate) > 1)) throw new ConfigurationDispatchError(`outbox.payload.patch.lines[${index}].taxRate 无效`);
      return {
        id: frozenText(line['id'], `outbox.payload.patch.lines[${index}].id`),
        itemCode: frozenText(line['itemCode'], `outbox.payload.patch.lines[${index}].itemCode`),
        description: frozenText(line['description'], `outbox.payload.patch.lines[${index}].description`),
        quantity: Number(quantity), unit: frozenText(line['unit'], `outbox.payload.patch.lines[${index}].unit`), unitPrice, taxRate,
      };
    });
  }
  return patch;
}

function odooPurchaseOrderAmendmentInput(input: Record<string, unknown>): { poNumber: string; odooId: number; patch: Record<string, unknown> } {
  return {
    poNumber: frozenText(input['poNumber'], 'poNumber'),
    odooId: frozenPositiveInteger(input['odooId'], 'odooId'),
    patch: frozenOdooPurchaseOrderAmendmentPatch(input['patch']),
  };
}

function normalizeOdooPurchaseOrderAmendmentResult(
  output: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!output) throw new Error('Odoo amendment 写入回执为空');
  const expectedPoName = frozenText(input['poNumber'], 'poNumber');
  const expectedOdooId = frozenPositiveInteger(input['odooId'], 'odooId');
  const patch = frozenOdooPurchaseOrderAmendmentPatch(input['patch']);
  const po = frozenRecord(output['po'], 'connectorResult.po');
  if (frozenPositiveInteger(po['id'], 'connectorResult.po.id') !== expectedOdooId || frozenText(po['name'], 'connectorResult.po.name') !== expectedPoName) {
    throw new Error('Odoo amendment 写后读取的采购订单不一致');
  }
  let readbackMatches = Object.keys(patch).length === 1 && patch['requiredInHouseAt'] !== undefined;
  if (patch['requiredInHouseAt'] !== undefined) {
    const expectedDate = frozenText(patch['requiredInHouseAt'], 'patch.requiredInHouseAt');
    const lines = po['lines'];
    const write = frozenRecord(output['write'], 'connectorResult.write');
    const updatedLines = frozenPositiveInteger(write['updated'] ?? write['lines'], 'connectorResult.write.updated');
    if (!Array.isArray(lines) || lines.length === 0 || updatedLines !== lines.length) {
      readbackMatches = false;
    } else {
      for (const [index, raw] of lines.entries()) {
        const line = frozenRecord(raw, `connectorResult.po.lines[${index}]`);
        const datePlanned = frozenText(line['datePlanned'] ?? line['date_planned'], `connectorResult.po.lines[${index}].datePlanned`);
        if (dateOnly(datePlanned) !== dateOnly(expectedDate)) readbackMatches = false;
      }
    }
  }
  const credential = output['credential'];
  return {
    po_name: expectedPoName,
    readbackMatches,
    receiptReference: `purchase.order:${expectedOdooId}`,
    ...(credential ? { credential } : {}),
  };
}

function normalizeOdooRihdResult(
  output: Record<string, unknown> | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!output) throw new Error('Odoo RIHD 写入回执为空');
  const expectedPoName = frozenText(input['poId'], 'poId');
  const expectedDate = frozenText(input['value'], 'value');
  const expectedLineCount = frozenPositiveInteger(input['expectedLineCount'], 'expectedLineCount');
  const credential = output['credential'];
  if (typeof output['po_name'] === 'string') {
    const poName = frozenText(output['po_name'], 'connectorResult.po_name');
    const requiredInHouseAt = frozenText(output['required_in_house_at'], 'connectorResult.required_in_house_at');
    const updatedLines = frozenPositiveInteger(output['updated_lines'], 'connectorResult.updated_lines');
    const verifiedLines = frozenPositiveInteger(output['verified_lines'], 'connectorResult.verified_lines');
    if (poName !== expectedPoName || dateOnly(requiredInHouseAt) !== dateOnly(expectedDate)
      || updatedLines !== expectedLineCount || verifiedLines !== expectedLineCount) {
      throw new Error('Odoo RIHD 写后核验回执与冻结输入不一致');
    }
    return { po_name: poName, required_in_house_at: new Date(Date.parse(expectedDate)).toISOString(), updated_lines: updatedLines, verified_lines: verifiedLines, ...(credential ? { credential } : {}) };
  }
  const po = frozenRecord(output['po'], 'connectorResult.po');
  const write = frozenRecord(output['write'], 'connectorResult.write');
  const poName = frozenText(po['name'], 'connectorResult.po.name');
  const lines = po['lines'];
  const updatedLines = frozenPositiveInteger(write['updated'] ?? write['lines'], 'connectorResult.write.updated');
  if (!Array.isArray(lines) || poName !== expectedPoName || lines.length !== expectedLineCount || updatedLines !== expectedLineCount) {
    throw new Error('Odoo RIHD 写后核验的采购单或行数不一致');
  }
  for (const [index, raw] of lines.entries()) {
    const line = frozenRecord(raw, `connectorResult.po.lines[${index}]`);
    const datePlanned = frozenText(line['datePlanned'] ?? line['date_planned'], `connectorResult.po.lines[${index}].datePlanned`);
    if (dateOnly(datePlanned) !== dateOnly(expectedDate)) throw new Error(`Odoo 第 ${index + 1} 行 RIHD 写后核验不一致`);
  }
  return {
    po_name: poName,
    required_in_house_at: new Date(Date.parse(expectedDate)).toISOString(),
    updated_lines: updatedLines,
    verified_lines: lines.length,
    ...(credential ? { credential } : {}),
  };
}

function dateOnly(value: string): string {
  const calendarDate = /^(\d{4}-\d{2}-\d{2})(?:[T\s]|$)/.exec(value.trim())?.[1];
  if (calendarDate) return calendarDate;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Odoo RIHD 日期无效');
  return new Date(time).toISOString().slice(0, 10);
}

function frozenRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConfigurationDispatchError(`${field} 必须是对象`);
  return value as Record<string, unknown>;
}
function frozenText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ConfigurationDispatchError(`${field} 必填`);
  return value.trim();
}
function frozenPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new ConfigurationDispatchError(`${field} 必须是正整数`);
  return value;
}
function frozenPositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new ConfigurationDispatchError(`${field} 必须大于 0`);
  return value;
}
function frozenNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ConfigurationDispatchError(`${field} 必须为非负数`);
  return value;
}

interface ProcurementAttachmentRow {
  id: string;
  sha256: string;
  version: number;
  status: string;
  security_status: string;
  size_bytes: number;
  storage_backend: string;
  object_key: string | null;
  content: Uint8Array | null;
}

function parseAttachmentSnapshots(value: unknown): ProcurementOutboxAttachmentSnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigurationDispatchError('RFQ outbox 附件快照格式无效');
  const snapshots = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ConfigurationDispatchError(`RFQ outbox 附件快照[${index}] 格式无效`);
    }
    const record = item as Record<string, unknown>;
    const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
    const sha256 = typeof record['sha256'] === 'string' ? record['sha256'].toLowerCase() : '';
    const version = record['version'];
    const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
    const contentType = typeof record['contentType'] === 'string' ? record['contentType'].trim() : '';
    const sizeBytes = record['sizeBytes'];
    if (!id || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(version) || Number(version) <= 0 || !name || !contentType || !Number.isSafeInteger(sizeBytes) || Number(sizeBytes) <= 0) {
      throw new ConfigurationDispatchError(`RFQ outbox 附件快照[${index}] 缺少可核验元数据`);
    }
    return { id, sha256, version: Number(version), name, contentType, sizeBytes: Number(sizeBytes) };
  });
  if (new Set(snapshots.map((item) => item.id)).size !== snapshots.length) {
    throw new ConfigurationDispatchError('RFQ outbox 附件快照 ID 重复');
  }
  return snapshots;
}

async function loadVerifiedAttachments(
  db: DatabaseSync,
  tenantId: string,
  snapshots: readonly ProcurementOutboxAttachmentSnapshot[],
  objectStorage?: AttachmentObjectStorage,
): Promise<Array<{ filename: string; contentType: string; content: Uint8Array }>> {
  const read = db.prepare(`SELECT id,sha256,version,status,security_status,size_bytes,storage_backend,object_key,content FROM procurement_attachments
    WHERE tenant_id=? AND id=?`);
  return Promise.all(snapshots.map(async (snapshot) => {
    const row = read.get(tenantId, snapshot.id) as unknown as ProcurementAttachmentRow | undefined;
    if (!row) throw new ConfigurationDispatchError(`RFQ 附件 ${snapshot.id} 不存在`);
    if (row.status !== 'active') throw new ConfigurationDispatchError(`RFQ 附件 ${snapshot.id} 已失效`);
    if (row.security_status !== 'clean') throw new ConfigurationDispatchError(`RFQ 附件 ${snapshot.id} 尚未通过恶意软件扫描，已阻止外发`);
    if (row.version !== snapshot.version) throw new ConfigurationDispatchError(`RFQ 附件 ${snapshot.id} 版本与冻结快照不一致`);
    const storedSha256 = row.sha256.toLowerCase();
    if (row.size_bytes !== snapshot.sizeBytes) {
      throw new ConfigurationDispatchError(`RFQ 附件 ${snapshot.id} 大小与冻结快照不一致`);
    }
    if (storedSha256 !== snapshot.sha256) {
      throw new ConfigurationDispatchError(`RFQ 附件 ${snapshot.id} sha256 与冻结快照不一致`);
    }
    let content: Uint8Array;
    try {
      content = await loadProcurementAttachmentContent({
        tenantId,
        attachmentId: row.id,
        version: row.version,
        sha256: row.sha256,
        sizeBytes: row.size_bytes,
        storageBackend: row.storage_backend,
        objectKey: row.object_key,
        content: row.content,
      }, objectStorage);
    } catch (error) {
      throw new ConfigurationDispatchError(error instanceof Error ? error.message : `RFQ 附件 ${snapshot.id} 无法读取`);
    }
    return { filename: snapshot.name, contentType: snapshot.contentType, content };
  }));
}

interface FrozenCommunicationIdentity {
  displayName: string;
  title: string;
  organizationName: string;
  version: number;
}

/**
 * External messages must use the identity snapshotted when the operator queued
 * the action. Reading the current tenant setting here would silently rewrite
 * the sender of an already-approved transaction.
 */
function frozenCommunicationIdentity(value: unknown): FrozenCommunicationIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigurationDispatchError('外发邮件缺少已冻结的采购专业联系人身份');
  }
  const candidate = value as Record<string, unknown>;
  const displayName = textIdentityField(candidate['displayName'], '联系人姓名');
  const title = textIdentityField(candidate['title'], '联系人职位');
  const organizationName = textIdentityField(candidate['organizationName'], '公司名称');
  const version = candidate['version'];
  if (!Number.isSafeInteger(version) || Number(version) <= 0) {
    throw new ConfigurationDispatchError('外发邮件的采购专业联系人身份版本无效');
  }
  return { displayName, title, organizationName, version: Number(version) };
}

function identityFromDraft(draft: { sender_name: string | null; sender_title: string | null; sender_organization: string | null }): FrozenCommunicationIdentity {
  return frozenCommunicationIdentity({
    displayName: draft.sender_name,
    title: draft.sender_title,
    organizationName: draft.sender_organization,
    // Message drafts predate the separate identity table. The individual
    // sender fields are the immutable approval snapshot; their version is not
    // needed for SMTP dispatch, but must be present to share the same guard.
    version: 1,
  });
}

function textIdentityField(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ConfigurationDispatchError(`外发邮件缺少${label}`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || /[\r\n]/.test(normalized)) {
    throw new ConfigurationDispatchError(`外发邮件${label}无效`);
  }
  return normalized;
}

function professionalSignature(identity: Pick<FrozenCommunicationIdentity, 'displayName' | 'title' | 'organizationName'>): string {
  return `此致\n${identity.displayName}\n${identity.title}｜${identity.organizationName}`;
}

class ConnectorDispatchError extends Error {}
class ConfigurationDispatchError extends Error {}
class GatewayRetryableDispatchError extends Error {}
class GatewayDeferredDispatchError extends Error {
  constructor(message: string, readonly nextAttemptAt: string, readonly replayed: boolean) { super(message); }
}
/** The external connector/runtime was entered, so its write outcome cannot be inferred locally. */
class ExternalDispatchStartedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause ?? '外部派发失败'));
    this.name = 'ExternalDispatchStartedError';
  }
}

function requiredLeaseToken(message: ProcurementOutboxMessage): string {
  if (!message.leaseToken) throw new Error('outbox 租约缺少 token');
  return message.leaseToken;
}

function isSafeBeforeDispatchFailure(error: unknown): boolean {
  if (error instanceof GatewayRetryableDispatchError) return true;
  if (error instanceof ConfigurationDispatchError) return false;
  const message = error instanceof Error ? error.message : String(error ?? '');
  // 连接拒绝/DNS/限流可确认对方未受理；超时或断线结果不确定，绝不自动重放。
  return /\b(econnrefused|enotfound|eai_again|enetunreach|429|rate\s*limit(?:ed)?|too\s+many\s+requests)\b/i.test(message)
    || /Meta WhatsApp HTTP (?:400|401|403|404|405|409|422)\b/.test(message)
    || /(?:连接被拒绝|请求过多|服务繁忙)/.test(message);
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}
