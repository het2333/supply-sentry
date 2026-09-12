import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { OdooErpClient } from '@readywork/connectors';
import { CredentialVault, type EncryptedCredential } from '@readywork/connector-runtime';

/**
 * Safe, durable identity of the credential used for one ERP operation.  It is
 * deliberately free of the encrypted payload, endpoint and API key so it can
 * be persisted in an outbox/audit record.
 */
export interface OdooCredentialAudit {
  credentialId: string;
  credentialVersion: string;
  lastTestedAt: string;
}

export interface ResolvedOdooRuntime {
  readonly client: OdooErpClient;
  readonly credential: OdooCredentialAudit;
}

interface CredentialRow {
  id: string;
  encrypted_json: string;
  updated_at: string;
  last_tested_at: string;
}

/**
 * The business-plane ERP resolver.  This intentionally reads the existing
 * Connector Control Plane tables rather than introducing another credential
 * store.  A resolve is tenant-scoped and fails closed unless the selected
 * credential is enabled, externally tested and decryptable.
 */
export class OdooRuntimeResolver {
  private readonly vault?: CredentialVault;
  private readonly cache = new Map<string, { key: string; runtime: ResolvedOdooRuntime }>();

  constructor(private readonly db: DatabaseSync | undefined, credentialKey = process.env['READYWORK_CREDENTIAL_KEY']) {
    if (credentialKey) this.vault = new CredentialVault(credentialKey);
  }

  resolve(tenantId: string): ResolvedOdooRuntime | undefined {
    if (!tenantId.trim() || !this.db || !this.vault) return undefined;
    const row = this.db.prepare(`SELECT c.id,c.encrypted_json,c.updated_at,c.last_tested_at
      FROM control_credentials c
      WHERE c.tenant_id=? AND c.connector_id='erp' AND c.credential_type='erpCredential'
        AND c.status='connected' AND c.last_tested_at IS NOT NULL AND c.last_error IS NULL
        AND COALESCE((
          SELECT i.status FROM control_connector_installations i
          WHERE i.tenant_id=c.tenant_id AND i.connector_id='erp'
          ORDER BY i.version DESC LIMIT 1
        ), 'installed') <> 'disabled'
      ORDER BY c.updated_at DESC,c.id DESC LIMIT 1`).get(tenantId) as CredentialRow | undefined;
    if (!row) {
      this.cache.delete(tenantId);
      return undefined;
    }
    // updated_at is the durable credential version; include a digest as a
    // same-millisecond save guard without retaining ciphertext in the cache.
    const key = `${row.id}:${row.updated_at}:${row.last_tested_at}:${createHash('sha256').update(row.encrypted_json).digest('hex')}`;
    const cached = this.cache.get(tenantId);
    if (cached?.key === key) return cached.runtime;
    try {
      const value = this.vault.decrypt(JSON.parse(row.encrypted_json) as EncryptedCredential);
      const baseUrl = String(value['baseUrl'] ?? '').replace(/\/$/, '');
      const database = String(value['database'] ?? '');
      const apiKey = String(value['apiKey'] ?? '');
      if (!baseUrl || !database || !apiKey) throw new Error('incomplete Odoo credential');
      const runtime: ResolvedOdooRuntime = {
        client: new OdooErpClient({ baseUrl, database, apiKey, timeoutMs: 10_000 }),
        credential: { credentialId: row.id, credentialVersion: row.updated_at, lastTestedAt: row.last_tested_at },
      };
      this.cache.set(tenantId, { key, runtime });
      return runtime;
    } catch {
      // Do not retain a formerly valid client after a corrupt rotation/key loss.
      this.cache.delete(tenantId);
      return undefined;
    }
  }

  /** Cache invalidation is normally natural (the DB metadata is part of key). */
  invalidate(tenantId?: string): void {
    if (tenantId) this.cache.delete(tenantId);
    else this.cache.clear();
  }

  /** Persist only the frozen credential identity for externally observable use. */
  recordUse(tenantId: string, action: string, credential: OdooCredentialAudit): void {
    if (!this.db || !tenantId.trim() || !action.trim()) return;
    this.db.prepare(`INSERT INTO control_connector_events
      (tenant_id,connector_id,event_type,status,message,metadata_json,created_at)
      VALUES (?,'erp','runtime_credential_resolved','success',?,?,?)`).run(
      tenantId,
      'ERP 运行时凭据已冻结',
      JSON.stringify({ action, credentialId: credential.credentialId, credentialVersion: credential.credentialVersion, lastTestedAt: credential.lastTestedAt }),
      new Date().toISOString(),
    );
  }
}
