import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export interface HermesPlatformSnapshot {
  readonly capturedAt: string;
  readonly catalog: Record<string, unknown>;
}

export interface HermesBridgeReceipt {
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly inboundId?: string;
  readonly deliveryId?: string;
  readonly result: Record<string, unknown>;
  readonly createdAt: string;
}

export interface HermesPlatformAction {
  readonly idempotencyKey: string;
  readonly platformId: string;
  readonly action: 'configure' | 'enable' | 'disable' | 'test' | 'onboarding';
  readonly requestFingerprint: string;
  readonly response: Record<string, unknown>;
  readonly configuredFields: readonly string[];
  readonly secretFingerprints: Readonly<Record<string, string>>;
  readonly actorId: string;
  readonly createdAt: string;
}

export class HermesRepository {
  constructor(
    private readonly db: DatabaseSync,
    readonly tenantId: string,
  ) {}

  profileForTenant(createdAt = new Date().toISOString()): string {
    const existing = this.db.prepare(
      'SELECT profile_id FROM hermes_tenant_profiles WHERE tenant_id=?',
    ).get(this.tenantId) as { profile_id: string } | undefined;
    if (existing) return existing.profile_id;
    const profileId = `rw-${createHash('sha256').update(this.tenantId).digest('hex').slice(0, 24)}`;
    this.db.prepare(`INSERT OR IGNORE INTO hermes_tenant_profiles
      (tenant_id,profile_id,created_at) VALUES (?,?,?)`).run(this.tenantId, profileId, createdAt);
    const stored = this.db.prepare(
      'SELECT profile_id FROM hermes_tenant_profiles WHERE tenant_id=?',
    ).get(this.tenantId) as { profile_id: string } | undefined;
    if (!stored) throw new Error('无法建立 Hermes 租户配置映射');
    return stored.profile_id;
  }

  savePlatformSnapshot(snapshot: HermesPlatformSnapshot): void {
    this.profileForTenant(snapshot.capturedAt);
    this.db.prepare(`INSERT INTO hermes_platform_snapshots (tenant_id,captured_at,catalog_json)
      VALUES (?,?,?)
      ON CONFLICT(tenant_id) DO UPDATE SET captured_at=excluded.captured_at,catalog_json=excluded.catalog_json`
    ).run(this.tenantId, snapshot.capturedAt, JSON.stringify(snapshot.catalog));
  }

  latestPlatformSnapshot(): HermesPlatformSnapshot | undefined {
    const row = this.db.prepare(`SELECT captured_at,catalog_json FROM hermes_platform_snapshots
      WHERE tenant_id=?`).get(this.tenantId) as { captured_at: string; catalog_json: string } | undefined;
    return row ? { capturedAt: row.captured_at, catalog: JSON.parse(row.catalog_json) as Record<string, unknown> } : undefined;
  }

  consumeNonce(nonce: string, createdAt: string, expiresAt: string): boolean {
    if (nonce.length < 8 || nonce.length > 160) return false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM hermes_bridge_nonces WHERE expires_at<=?').run(createdAt);
      const existing = this.db.prepare(`SELECT 1 FROM hermes_bridge_nonces
        WHERE tenant_id=? AND nonce=?`).get(this.tenantId, nonce);
      if (existing) {
        this.db.exec('COMMIT');
        return false;
      }
      this.db.prepare(`INSERT INTO hermes_bridge_nonces
        (tenant_id,nonce,expires_at,created_at) VALUES (?,?,?,?)`
      ).run(this.tenantId, nonce, expiresAt, createdAt);
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  recordBridgeReceipt(receipt: HermesBridgeReceipt): { replayed: boolean } {
    const existing = this.db.prepare(`SELECT request_fingerprint FROM hermes_bridge_receipts
      WHERE tenant_id=? AND request_id=?`).get(this.tenantId, receipt.requestId) as { request_fingerprint: string } | undefined;
    if (existing) {
      if (existing.request_fingerprint !== receipt.requestFingerprint) throw new Error('Bridge 请求标识已被不同载荷使用');
      return { replayed: true };
    }
    this.db.prepare(`INSERT INTO hermes_bridge_receipts
      (tenant_id,request_id,request_fingerprint,inbound_id,delivery_id,result_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
        this.tenantId,
        receipt.requestId,
        receipt.requestFingerprint,
        receipt.inboundId ?? null,
        receipt.deliveryId ?? null,
        JSON.stringify(receipt.result),
        receipt.createdAt,
      );
    return { replayed: false };
  }

  bridgeReceipt(requestId: string): HermesBridgeReceipt | undefined {
    const row = this.db.prepare(`SELECT request_id,request_fingerprint,inbound_id,delivery_id,result_json,created_at
      FROM hermes_bridge_receipts WHERE tenant_id=? AND request_id=?`
    ).get(this.tenantId, requestId) as {
      request_id: string; request_fingerprint: string; inbound_id: string | null;
      delivery_id: string | null; result_json: string; created_at: string;
    } | undefined;
    return row ? {
      requestId: row.request_id,
      requestFingerprint: row.request_fingerprint,
      ...(row.inbound_id ? { inboundId: row.inbound_id } : {}),
      ...(row.delivery_id ? { deliveryId: row.delivery_id } : {}),
      result: JSON.parse(row.result_json) as Record<string, unknown>,
      createdAt: row.created_at,
    } : undefined;
  }

  recordPlatformAction(action: HermesPlatformAction): { replayed: boolean; response: Record<string, unknown> } {
    const existing = this.platformAction(action.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== action.requestFingerprint) throw new Error('Hermes 操作幂等键已被不同请求使用');
      return { replayed: true, response: existing.response };
    }
    this.db.prepare(`INSERT INTO hermes_platform_actions
      (tenant_id,idempotency_key,platform_id,action,request_fingerprint,response_json,
       configured_fields_json,secret_fingerprints_json,actor_id,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        this.tenantId,
        action.idempotencyKey,
        action.platformId,
        action.action,
        action.requestFingerprint,
        JSON.stringify(action.response),
        JSON.stringify([...action.configuredFields]),
        JSON.stringify(action.secretFingerprints),
        action.actorId,
        action.createdAt,
      );
    return { replayed: false, response: action.response };
  }

  platformAction(idempotencyKey: string): {
    requestFingerprint: string;
    response: Record<string, unknown>;
  } | undefined {
    const row = this.db.prepare(`SELECT request_fingerprint,response_json FROM hermes_platform_actions
      WHERE tenant_id=? AND idempotency_key=?`
    ).get(this.tenantId, idempotencyKey) as { request_fingerprint: string; response_json: string } | undefined;
    return row ? {
      requestFingerprint: row.request_fingerprint,
      response: JSON.parse(row.response_json) as Record<string, unknown>,
    } : undefined;
  }
}
