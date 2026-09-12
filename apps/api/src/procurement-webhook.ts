import type { DatabaseSync } from 'node:sqlite';
import type {
  PurchaseOrderLine,
  PurchaseOrderLineQuantityEvent,
  PurchaseOrderQuantityDimension,
  QuantityProjectionResult,
} from '@readywork/core';
import {
  createProcurementRepository,
  ProcurementQuantityEventConflictError,
} from '@readywork/persistence';
import type { ConnectorExecutionResult } from '@readywork/connector-runtime';
import { redactSensitive } from './http-errors.js';

const QUANTITY_EVENT_DIMENSIONS = {
  'po_line.confirmed': 'confirmed',
  'shipment.line_recorded': 'shipped',
  'receipt.line_recorded': 'received',
  'invoice.line_recorded': 'invoiced',
  'po_line.cancelled': 'cancelled',
} as const satisfies Record<string, PurchaseOrderQuantityDimension>;

interface SignedWebhookVerifier {
  receiveWebhook(
    credentialId: string,
    input: SignedWebhookInput,
  ): Promise<ConnectorExecutionResult>;
}

export interface SignedWebhookInput {
  readonly rawBody: string;
  readonly payload: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
  readonly signature?: string;
}

export interface ProcessSignedWebhookInput {
  readonly db: DatabaseSync;
  readonly tenantId: string;
  readonly credentialId: string;
  readonly verifier: SignedWebhookVerifier;
  readonly webhook: SignedWebhookInput;
}

export interface ProcessSignedWebhookResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

class ProcurementWebhookError extends Error {
  constructor(readonly status: 404 | 422, message: string, readonly code: string) {
    super(message);
    this.name = 'ProcurementWebhookError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProcurementWebhookError(422, `${field} 必填`, 'INVALID_QUANTITY_EVENT');
  }
  return value.trim();
}

function sourceSystem(payload: Record<string, unknown>, credentialId: string): string {
  const supplied = payload['sourceSystem'] ?? payload['source'];
  const raw = supplied === undefined
    ? `webhook:${credentialId}`
    : requiredString(supplied, 'sourceSystem');
  const normalized = raw.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!normalized) throw new ProcurementWebhookError(422, 'sourceSystem 无效', 'INVALID_QUANTITY_EVENT');
  return normalized;
}

function quantityEvent(
  tenantId: string,
  credentialId: string,
  eventType: keyof typeof QUANTITY_EVENT_DIMENSIONS,
  payload: Record<string, unknown>,
): PurchaseOrderLineQuantityEvent {
  const delta = payload['delta'];
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) {
    throw new ProcurementWebhookError(422, 'delta 必须是非零有限数', 'INVALID_QUANTITY_EVENT');
  }
  const occurredAtInput = requiredString(payload['occurredAt'], 'occurredAt');
  const occurredAtTime = Date.parse(occurredAtInput);
  if (!Number.isFinite(occurredAtTime)) {
    throw new ProcurementWebhookError(422, 'occurredAt 必须是有效日期', 'INVALID_QUANTITY_EVENT');
  }
  return {
    tenantId,
    sourceSystem: sourceSystem(payload, credentialId),
    sourceEventId: requiredString(payload['sourceEventId'], 'sourceEventId'),
    poLineId: requiredString(payload['poLineId'], 'poLineId'),
    dimension: QUANTITY_EVENT_DIMENSIONS[eventType],
    delta,
    occurredAt: new Date(occurredAtTime).toISOString(),
  };
}

/** 仅处理已经通过 Connector HMAC 验签的五类数量事实。未知事件返回 undefined。 */
export function applyVerifiedProcurementWebhook(
  db: DatabaseSync,
  tenantId: string,
  credentialId: string,
  eventType: string,
  payload: Record<string, unknown>,
): QuantityProjectionResult | undefined {
  if (!(eventType in QUANTITY_EVENT_DIMENSIONS)) return undefined;
  const repository = createProcurementRepository(db, tenantId);
  const event = quantityEvent(
    tenantId,
    credentialId,
    eventType as keyof typeof QUANTITY_EVENT_DIMENSIONS,
    payload,
  );
  const line = repository.getLine<PurchaseOrderLine>('purchase_order_line', event.poLineId);
  if (!line) throw new ProcurementWebhookError(404, 'PO 行不存在', 'PO_LINE_NOT_FOUND');
  try {
    return repository.applyPurchaseOrderLineQuantityEvent(line, event);
  } catch (error) {
    if (error instanceof ProcurementQuantityEventConflictError) throw error;
    if (error instanceof Error) {
      throw new ProcurementWebhookError(422, redactSensitive(error), 'INVALID_QUANTITY_EVENT');
    }
    throw error;
  }
}

/** 验签成功之后才可能落账；路由和测试共用同一处理边界。 */
export async function processSignedProcurementWebhook(input: ProcessSignedWebhookInput): Promise<ProcessSignedWebhookResult> {
  try {
    const verified = await input.verifier.receiveWebhook(input.credentialId, input.webhook);
    if (!verified.ok) {
      return {
        status: 401,
        body: { ...verified, error: redactSensitive(verified.error ?? 'Webhook 验证失败') },
      };
    }
    const event = isRecord(verified.output?.['event']) ? verified.output['event'] : undefined;
    const eventType = event ? String(event['type'] ?? '') : '';
    const payload = event && isRecord(event['payload']) ? event['payload'] : {};
    const quantity = applyVerifiedProcurementWebhook(input.db, input.tenantId, input.credentialId, eventType, payload);
    if (!quantity) return { status: 202, body: { ...verified } };
    return {
      status: 202,
      body: {
        ok: true,
        event,
        applied: quantity.applied,
        projection: quantity.projection,
        issues: quantity.issues,
      },
    };
  } catch (error) {
    if (error instanceof ProcurementQuantityEventConflictError) {
      return { status: 409, body: { ok: false, error: error.message, code: 'QUANTITY_EVENT_CONFLICT' } };
    }
    if (error instanceof ProcurementWebhookError) {
      return { status: error.status, body: { ok: false, error: error.message, code: error.code } };
    }
    return { status: 500, body: { ok: false, error: 'Webhook 数量事件处理失败', code: 'WEBHOOK_PROCESSING_FAILED' } };
  }
}
