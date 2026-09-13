import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import { PUBLIC_DEMO_TENANT_ID } from './public-demo-mode.js';
import {
  PUBLIC_DEMO_IDS,
  PUBLIC_DEMO_SEED_VERSION,
  seedPublicDemo,
  type PublicDemoSeedSummary,
} from './public-demo-seed.js';

export { PUBLIC_DEMO_IDS, PUBLIC_DEMO_SEED_VERSION };

export interface PublicDemoStatus {
  demoMode: true;
  tenantId: typeof PUBLIC_DEMO_TENANT_ID;
  seedVersion: typeof PUBLIC_DEMO_SEED_VERSION;
  generation: number;
  resetAt: string;
  status: 'healthy' | 'degraded';
}

export interface PublicDemoResetResult extends PublicDemoSeedSummary {
  ok: true;
}

export class PublicDemoResetInProgressError extends Error {
  readonly code = 'DEMO_RESET_IN_PROGRESS' as const;
  constructor() {
    super('Public demo reset is already in progress');
    this.name = 'PublicDemoResetInProgressError';
  }
}

function rollback(db: DatabaseSync): void {
  try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function acquireResetLease(db: DatabaseSync, token: string, now: Date): void {
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const lease = db.prepare(`SELECT lease_expires_at FROM public_demo_reset_lease WHERE tenant_id=?`).get(PUBLIC_DEMO_TENANT_ID) as { lease_expires_at: string } | undefined;
    if (lease && Date.parse(lease.lease_expires_at) > now.getTime()) throw new PublicDemoResetInProgressError();
    db.prepare(`INSERT INTO public_demo_reset_lease (tenant_id,lease_token,lease_expires_at) VALUES (?,?,?)
      ON CONFLICT(tenant_id) DO UPDATE SET lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at`).run(
        PUBLIC_DEMO_TENANT_ID, token, expiresAt,
      );
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

function clearPublicDemoTenant(db: DatabaseSync): void {
  const protectedTables = new Set(['public_demo_state', 'public_demo_reset_lease', 'public_demo_audit']);
  const tables = (db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).filter(({ name }) => {
      if (protectedTables.has(name)) return false;
      return (db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string }>).some((column) => column.name === 'tenant_id');
    });
  const deleteGuards = (db.prepare(`SELECT name,sql FROM sqlite_master
    WHERE type='trigger' AND sql IS NOT NULL ORDER BY name`).all() as Array<{ name: string; sql: string }>).filter((trigger) => /\bBEFORE\s+DELETE\b/i.test(trigger.sql));

  for (const trigger of deleteGuards) db.exec(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
  try {
    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const { name } of tables) db.prepare(`DELETE FROM ${quoteIdentifier(name)} WHERE tenant_id=?`).run(PUBLIC_DEMO_TENANT_ID);
  } finally {
    for (const trigger of deleteGuards) db.exec(trigger.sql);
  }
}

function markResetFailure(db: DatabaseSync, token: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE public_demo_state SET reset_status='degraded',last_error_code='DEMO_RESET_FAILED'
      WHERE tenant_id=?`).run(PUBLIC_DEMO_TENANT_ID);
    db.prepare(`DELETE FROM public_demo_reset_lease WHERE tenant_id=? AND lease_token=?`).run(PUBLIC_DEMO_TENANT_ID, token);
    db.exec('COMMIT');
  } catch {
    rollback(db);
  }
}

export function resetPublicDemo(db: DatabaseSync, now = new Date()): PublicDemoResetResult {
  initializeControlPlaneSchema(db);
  const resetAt = now.toISOString();
  const token = randomUUID();
  acquireResetLease(db, token, now);

  db.exec('BEGIN IMMEDIATE');
  try {
    const state = db.prepare(`SELECT generation FROM public_demo_state WHERE tenant_id=?`).get(PUBLIC_DEMO_TENANT_ID) as { generation: number } | undefined;
    const generation = (state?.generation ?? 0) + 1;
    clearPublicDemoTenant(db);
    const seeded = seedPublicDemo(db, { resetAt, generation });
    db.prepare(`INSERT INTO public_demo_state
      (tenant_id,seed_version,generation,reset_at,reset_status,last_error_code) VALUES (?,?,?,?,'healthy',NULL)
      ON CONFLICT(tenant_id) DO UPDATE SET seed_version=excluded.seed_version,generation=excluded.generation,
        reset_at=excluded.reset_at,reset_status='healthy',last_error_code=NULL`).run(
          PUBLIC_DEMO_TENANT_ID, PUBLIC_DEMO_SEED_VERSION, generation, resetAt,
        );
    db.prepare(`INSERT INTO public_demo_audit
      (tenant_id,id,generation,event_type,detail_json,created_at) VALUES (?,?,?,?,?,?)`).run(
        PUBLIC_DEMO_TENANT_ID, `public-demo-audit:${generation}:${token}`, generation, 'public_demo.reset.completed',
        JSON.stringify({ seedVersion: PUBLIC_DEMO_SEED_VERSION, scenarioCount: seeded.scenarioCount }), resetAt,
      );
    db.prepare(`DELETE FROM public_demo_reset_lease WHERE tenant_id=? AND lease_token=?`).run(PUBLIC_DEMO_TENANT_ID, token);
    db.exec('COMMIT');
    return { ok: true, ...seeded };
  } catch (error) {
    rollback(db);
    markResetFailure(db, token);
    throw error;
  }
}

export function readPublicDemoStatus(db: DatabaseSync): PublicDemoStatus {
  initializeControlPlaneSchema(db);
  const row = db.prepare(`SELECT seed_version,generation,reset_at,reset_status
    FROM public_demo_state WHERE tenant_id=?`).get(PUBLIC_DEMO_TENANT_ID) as {
      seed_version: string; generation: number; reset_at: string; reset_status: 'healthy' | 'degraded';
    } | undefined;
  if (!row || row.seed_version !== PUBLIC_DEMO_SEED_VERSION) throw new Error('Public demo seed state is unavailable');
  return {
    demoMode: true,
    tenantId: PUBLIC_DEMO_TENANT_ID,
    seedVersion: PUBLIC_DEMO_SEED_VERSION,
    generation: row.generation,
    resetAt: row.reset_at,
    status: row.reset_status,
  };
}
