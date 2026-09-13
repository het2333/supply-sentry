import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { PUBLIC_DEMO_TENANT_ID } from './public-demo-mode.js';
import { PUBLIC_DEMO_SEED_VERSION } from './public-demo-seed.js';

export interface PublicDemoReceipt extends Record<string, unknown> {
  receiptKind: 'simulated_demo';
  outcome: 'accepted' | 'uncertain';
  externalDelivery: false;
  connector: string;
  action: string;
  reference: string;
  generatedAt: string;
  generation: number;
}

export interface CreateSimulatedDemoReceiptInput {
  db: DatabaseSync;
  tenantId: string;
  scenarioId: string;
  connector: string;
  action: string;
  idempotencyKey: string;
  generatedAt?: string;
}

export function isPublicDemoTenant(tenantId: string): tenantId is typeof PUBLIC_DEMO_TENANT_ID {
  return tenantId === PUBLIC_DEMO_TENANT_ID;
}

export function createSimulatedDemoReceipt(input: CreateSimulatedDemoReceiptInput): PublicDemoReceipt {
  if (!isPublicDemoTenant(input.tenantId)) throw new Error('Simulated demo receipts are restricted to the public demo tenant');
  const state = input.db.prepare(`SELECT seed_version,generation,reset_status FROM public_demo_state
    WHERE tenant_id=?`).get(PUBLIC_DEMO_TENANT_ID) as {
      seed_version: string;
      generation: number;
      reset_status: string;
    } | undefined;
  if (!state || state.seed_version !== PUBLIC_DEMO_SEED_VERSION || state.reset_status !== 'healthy'
    || !Number.isSafeInteger(state.generation) || state.generation <= 0) {
    throw new Error('Public demo receipt state is unavailable');
  }
  const scenario = input.db.prepare(`SELECT payload_json FROM public_demo_scenarios
    WHERE tenant_id=? AND id=?`).get(PUBLIC_DEMO_TENANT_ID, input.scenarioId) as { payload_json: string } | undefined;
  if (!scenario) throw new Error('Public demo action is not bound to a seeded scenario');
  const metadata = JSON.parse(scenario.payload_json) as Record<string, unknown>;
  const outcome = metadata['simulationOutcome'];
  if (outcome !== 'accepted' && outcome !== 'uncertain') throw new Error('Public demo scenario simulation outcome is invalid');
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('Public demo receipt timestamp is invalid');
  const connector = requiredText(input.connector, 'connector');
  const action = requiredText(input.action, 'action');
  const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey');
  const digest = createHash('sha256')
    .update(`${state.generation}\u0000${input.scenarioId}\u0000${connector}\u0000${action}\u0000${idempotencyKey}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
  return {
    receiptKind: 'simulated_demo',
    outcome,
    externalDelivery: false,
    connector,
    action,
    reference: `SIM-${state.generation}-${digest}`,
    generatedAt,
    generation: state.generation,
  };
}

export function recordSimulatedDemoReceipt(
  db: DatabaseSync,
  input: { receipt: PublicDemoReceipt; scenarioId: string; source: 'action_gateway' | 'procurement_outbox' },
): void {
  const id = `public-demo-audit:receipt:${input.receipt.generation}:${input.receipt.reference}`;
  db.prepare(`INSERT OR IGNORE INTO public_demo_audit
    (tenant_id,id,generation,event_type,detail_json,created_at) VALUES (?,?,?,?,?,?)`).run(
      PUBLIC_DEMO_TENANT_ID,
      id,
      input.receipt.generation,
      'public_demo.external_action.simulated',
      JSON.stringify({ receipt: input.receipt, scenarioId: input.scenarioId, source: input.source }),
      input.receipt.generatedAt,
    );
}

export function isPublicDemoReceipt(value: unknown): value is PublicDemoReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return receipt['receiptKind'] === 'simulated_demo'
    && (receipt['outcome'] === 'accepted' || receipt['outcome'] === 'uncertain')
    && receipt['externalDelivery'] === false;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 500) throw new Error(`Public demo receipt ${field} is invalid`);
  return normalized;
}
