import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openPersistence, runMigrations } from '@readywork/persistence';

const migrationName = 'navisight-clean-room-alignment-v2';
const newTables = [
  'procurement_supplier_operating_profiles',
  'procurement_supplier_operating_profile_events',
  'procurement_purchase_order_amendments',
  'procurement_purchase_order_amendment_audit',
  'procurement_purchase_order_document_requests',
  'procurement_purchase_order_document_snapshots',
  'procurement_route_exports',
] as const;

function tempDatabase(prefix: string): { directory: string; path: string; cleanup(): void } {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return { directory, path: join(directory, 'readywork.sqlite'), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function insertProfile(db: DatabaseSync, id: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    tenant_id: 'tenant:isolated', supplier_id: id, version: 1, country_code: '', route: 'local', supplier_type: 'other',
    industry: '', address_json: 'null', primary_material_code: '', primary_material_name: '', default_lead_time_days: null,
    product_criticality: 'unclassified', payment_terms: '', contract_starts_on: null, contract_ends_on: null,
    status: 'active', created_at: 'x', updated_at: 'x', ...overrides,
  };
  db.prepare(`INSERT INTO procurement_supplier_operating_profiles
    (tenant_id,supplier_id,version,country_code,route,supplier_type,industry,address_json,primary_material_code,primary_material_name,
     default_lead_time_days,product_criticality,payment_terms,contract_starts_on,contract_ends_on,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row['tenant_id'] as string, row['supplier_id'] as string, row['version'] as number, row['country_code'] as string,
    row['route'] as string, row['supplier_type'] as string, row['industry'] as string, row['address_json'] as string,
    row['primary_material_code'] as string, row['primary_material_name'] as string, row['default_lead_time_days'] as number | null,
    row['product_criticality'] as string, row['payment_terms'] as string, row['contract_starts_on'] as string | null,
    row['contract_ends_on'] as string | null, row['status'] as string, row['created_at'] as string, row['updated_at'] as string,
  );
}

function insertRouteExport(db: DatabaseSync, id: string, overrides: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    tenant_id: 'tenant:isolated', id, route: 'local', normalized_filters_json: '{}', source_watermark: 'w', row_count: 0,
    content_sha256: 'a'.repeat(64), size_bytes: 0, object_key: 'key', state: 'ready', created_by: 'human:one',
    created_at: 'x', expires_at: 'x', idempotency_key: id, ...overrides,
  };
  db.prepare(`INSERT INTO procurement_route_exports
    (tenant_id,id,route,normalized_filters_json,source_watermark,row_count,content_sha256,size_bytes,object_key,state,created_by,created_at,expires_at,idempotency_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row['tenant_id'] as string, row['id'] as string, row['route'] as string, row['normalized_filters_json'] as string,
    row['source_watermark'] as string, row['row_count'] as number, row['content_sha256'] as string, row['size_bytes'] as number,
    row['object_key'] as string, row['state'] as string, row['created_by'] as string, row['created_at'] as string,
    row['expires_at'] as string, row['idempotency_key'] as string,
  );
}

function concurrentOpen(path: string, startAt: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const source = `
    import { openPersistence } from '@readywork/persistence';
    const [path, startAt] = process.argv.slice(1);
    while (Date.now() < Number(startAt)) {}
    const store = openPersistence(path, { tenantId: 'tenant:concurrent-v49' });
    const row = store.db.prepare('SELECT name FROM schema_migrations WHERE version=49').get();
    process.stdout.write(String(row?.name ?? 'missing'));
    store.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source, path, String(startAt)], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('migration 49 installs the additive clean-room v2 schema on a fresh database without seed rows', () => {
  const fixture = tempDatabase('readywork-clean-room-v2-fresh-');
  try {
    const store = openPersistence(fixture.path, { tenantId: 'tenant:fresh-v49' });
    const migration = store.db.prepare('SELECT name FROM schema_migrations WHERE version=49').get() as { name: string };
    assert.equal(migration.name, migrationName);
    assert.equal((store.db.prepare('SELECT name FROM schema_migrations WHERE version=50').get() as { name: string }).name, 'procurement-material-lead-time-criticality');
    assert.ok(columns(store.db, 'procurement_material_lead_times').includes('criticality'));
    assert.throws(() => store.db.prepare(`INSERT INTO procurement_material_lead_times
      (tenant_id,id,supplier_id,supplier_name_snapshot,procurement_route,match_key,standard_lead_time_days,criticality,status,version,created_by,updated_by,created_at,updated_at)
      VALUES ('tenant:x','lead:x','supplier:x','Supplier','local','*',10,'urgent','active',1,'human:x','human:x','x','x')`).run(), /CHECK constraint failed/u);
    for (const table of newTables) {
      assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
      assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0, `${table} must not be seeded`);
    }
    assert.deepEqual(columns(store.db, 'procurement_purchase_order_document_requests'), [
      'tenant_id', 'snapshot_id', 'po_id', 'source_po_version', 'payload_fingerprint', 'projection_json',
      'generated_by', 'generated_at', 'state', 'owner_token', 'lease_version', 'lease_expires_at',
      'last_error', 'created_at', 'updated_at',
    ]);
    assert.ok(columns(store.db, 'procurement_advanced_sla_profiles').includes('schema_version'));
    for (const column of [
      'template_version', 'schema_version', 'domain', 'source_sha256', 'total_count', 'valid_count', 'invalid_count',
      'warning_count', 'candidate_hash', 'validation_results_json', 'validated_at',
    ]) assert.ok(columns(store.db, 'procurement_advanced_sla_import_batches').includes(column), column);

    assert.throws(() => store.db.prepare(`INSERT INTO procurement_supplier_operating_profiles
      (tenant_id,supplier_id,version,country_code,route,supplier_type,industry,address_json,primary_material_code,primary_material_name,
       default_lead_time_days,product_criticality,payment_terms,contract_starts_on,contract_ends_on,status,created_at,updated_at)
      VALUES ('tenant:x','supplier:x',0,'CN','guess','maker','','{}','','',-1,'urgent','','2026-09-03','2026-09-02','unknown','x','x')`).run(), /CHECK constraint failed|invalid supplier address/u);
    store.db.prepare(`INSERT INTO procurement_supplier_operating_profiles
      (tenant_id,supplier_id,version,country_code,route,supplier_type,industry,address_json,primary_material_code,primary_material_name,
       default_lead_time_days,product_criticality,payment_terms,contract_starts_on,contract_ends_on,status,created_at,updated_at)
      VALUES ('tenant:criticality','supplier:unclassified',1,'','unclassified','other','','null','','',NULL,'unclassified','',NULL,NULL,'inactive','x','x')`).run();
    assert.throws(() => store.db.prepare(`INSERT INTO procurement_supplier_operating_profiles
      (tenant_id,supplier_id,version,country_code,route,supplier_type,industry,address_json,primary_material_code,primary_material_name,
       default_lead_time_days,product_criticality,payment_terms,contract_starts_on,contract_ends_on,status,created_at,updated_at)
      VALUES ('tenant:criticality','supplier:critical',1,'','unclassified','other','','null','','',NULL,'critical','',NULL,NULL,'inactive','x','x')`).run(), /CHECK constraint failed/u);
    assert.throws(() => store.db.prepare(`INSERT INTO procurement_supplier_operating_profiles
      (tenant_id,supplier_id,version,route,supplier_type,address_json,product_criticality,status,created_at,updated_at)
      VALUES ('tenant:address','supplier:invalid-json',1,'local','other','{','unclassified','active','x','x')`).run(), /CHECK constraint failed|invalid supplier address|malformed JSON/u);
    assert.throws(() => store.db.prepare(`INSERT INTO procurement_supplier_operating_profiles
      (tenant_id,supplier_id,version,route,supplier_type,address_json,product_criticality,status,created_at,updated_at)
      VALUES ('tenant:address','supplier:incomplete-address',1,'local','other','{"line1":"one"}','unclassified','active','x','x')`).run(), /CHECK constraint failed|invalid supplier address/u);
    assert.throws(() => store.db.prepare(`INSERT INTO procurement_supplier_operating_profiles
      (tenant_id,supplier_id,version,route,supplier_type,address_json,product_criticality,status,created_at,updated_at)
      VALUES ('tenant:address','supplier:empty-address-field',1,'local','other','{"line1":"","line2":null,"city":"Shenzhen","region":null,"postalCode":null,"countryCode":"CN"}','unclassified','active','x','x')`).run(), /invalid supplier address/u);
    assert.throws(() => store.db.prepare(`INSERT INTO procurement_supplier_operating_profiles
      (tenant_id,supplier_id,version,route,supplier_type,address_json,product_criticality,contract_starts_on,status,created_at,updated_at)
      VALUES ('tenant:date','supplier:impossible-date',1,'local','other','null','unclassified','2026-02-29','active','x','x')`).run(), /CHECK constraint failed/u);
    assert.throws(() => store.db.prepare(`INSERT INTO procurement_route_exports
      (tenant_id,id,route,normalized_filters_json,source_watermark,row_count,content_sha256,size_bytes,object_key,state,created_by,created_at,expires_at,idempotency_key)
      VALUES ('tenant:x','export:x','other','{}','watermark',-1,'bad',-1,'key','building','human:x','x','x','key')`).run(), /CHECK constraint failed/u);
    assert.throws(() => store.db.prepare(`INSERT INTO procurement_advanced_sla_profiles
      (tenant_id,id,name,description,status,version,schema_version,sections_json,auto_send_json,created_by,updated_by,created_at,updated_at)
      VALUES ('tenant:x','profile:x','x','','draft',1,3,'[]','{}','human:x','human:x','x','x')`).run(), /CHECK constraint failed/u);
    store.close();
  } finally { fixture.cleanup(); }
});

test('migration 49 applies each supplier-profile and route-export constraint independently', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:isolated' });
  try {
    for (const [name, change] of [
      ['profile version', { version: 0 }], ['profile route', { route: 'other' }], ['profile type', { supplier_type: 'broker' }],
      ['profile lead time', { default_lead_time_days: -1 }], ['profile criticality', { product_criticality: 'critical' }],
      ['profile status', { status: 'paused' }], ['profile date order', { contract_starts_on: '2026-10-02', contract_ends_on: '2026-10-01' }],
      ['top-level country code', { country_code: '1A' }], ['address country code', { address_json: '{"line1":"One","line2":null,"city":"Austin","region":null,"postalCode":null,"countryCode":"1A"}' }],
    ] as const) assert.throws(() => insertProfile(store.db, `supplier:${name}`, change), /CHECK constraint failed|invalid supplier address/u, name);
    for (const [name, change] of [
      ['export route', { route: 'other' }], ['export row count', { row_count: -1 }], ['export hash', { content_sha256: 'bad' }],
      ['export size', { size_bytes: -1 }], ['export state', { state: 'building' }],
    ] as const) assert.throws(() => insertRouteExport(store.db, `export:${name}`, change), /CHECK constraint failed/u, name);
  } finally { store.close(); }
});

test('migration 49 upgrades a database with only migration 48 recorded and reruns as a no-op', () => {
  const fixture = tempDatabase('readywork-clean-room-v2-v48-');
  try {
    const db = new DatabaseSync(fixture.path);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    db.prepare('INSERT INTO schema_migrations (version,name,applied_at) VALUES (48,?,?)').run('procurement-route-chat-attachments', '2026-09-01T00:00:00.000Z');
    const applied = runMigrations(db);
    const recorded = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    // Only v48 was present. Count newly recorded migrations rather than fixing
    // the latest schema version; later additive migrations must remain allowed.
    assert.equal(applied, recorded.length - 1);
    assert.ok(applied > 0);
    assert.equal((db.prepare('SELECT applied_at FROM schema_migrations WHERE version=48').get() as { applied_at: string }).applied_at, '2026-09-01T00:00:00.000Z');
    assert.equal((db.prepare('SELECT name FROM schema_migrations WHERE version=49').get() as { name: string }).name, migrationName);
    assert.equal((db.prepare('SELECT name FROM schema_migrations WHERE version=50').get() as { name: string }).name, 'procurement-material-lead-time-criticality');
    assert.equal(runMigrations(db), 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=49').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=50').get() as { count: number }).count, 1);
    db.close();
  } finally { fixture.cleanup(); }
});

test('a recorded migration 49 is a no-op only when its exact current schema is present', () => {
  const fixture = tempDatabase('readywork-clean-room-v2-recorded-');
  try {
    const store = openPersistence(fixture.path, { tenantId: 'tenant:recorded-v49' });
    assert.equal(runMigrations(store.db), 0);
    store.db.exec('DROP TABLE procurement_purchase_order_amendment_audit');
    assert.throws(() => runMigrations(store.db), /migration 49.*schema|procurement_purchase_order_amendment_audit/u);
    store.close();
  } finally { fixture.cleanup(); }
});

test('a recorded material lead-time criticality migration fails closed when its constrained column drifts', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:recorded-v50' });
  try {
    store.db.exec('ALTER TABLE procurement_material_lead_times DROP COLUMN criticality');
    assert.throws(() => runMigrations(store.db), /migration 50.*criticality|criticality.*constraint/u);
  } finally { store.close(); }
});

test('recorded migration 49 fails closed when a required trigger, index, or Advanced SLA column drifts', () => {
  for (const [name, mutate] of [
    ['address trigger', (db: DatabaseSync) => db.exec('DROP TRIGGER trg_procurement_supplier_operating_profiles_valid_address_insert')],
    ['append-only trigger', (db: DatabaseSync) => db.exec('DROP TRIGGER trg_procurement_purchase_order_document_snapshots_no_update')],
    ['route index', (db: DatabaseSync) => db.exec('DROP INDEX idx_procurement_supplier_operating_profiles_route')],
    ['advanced SLA column', (db: DatabaseSync) => db.exec('ALTER TABLE procurement_advanced_sla_profiles DROP COLUMN schema_version')],
  ] as const) {
    const store = openPersistence(':memory:', { tenantId: `tenant:drift:${name}` });
    try {
      mutate(store.db);
      assert.throws(() => runMigrations(store.db), /migration 49.*schema|missing/u, name);
    } finally { store.close(); }
  }
});

test('recorded migration 49 fails closed when its unknown-state or criticality CHECK drifts', () => {
  for (const [name, mutate] of [
    ['unknown state', (db: DatabaseSync) => db.exec(`
      DROP TABLE procurement_purchase_order_amendments;
      CREATE TABLE procurement_purchase_order_amendments (
        tenant_id TEXT NOT NULL,id TEXT NOT NULL,po_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('edit','cancel')),
        source_po_version INTEGER NOT NULL CHECK(source_po_version>=1),normalized_patch_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('requested','queued','pending','dispatched','applied','failed','rejected','cancelled')),
        outbox_id TEXT,receipt_reference TEXT,idempotency_key TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,applied_at TEXT,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,idempotency_key));
      CREATE INDEX idx_procurement_purchase_order_amendments_po ON procurement_purchase_order_amendments(tenant_id,po_id,created_at,id);
      CREATE TRIGGER trg_procurement_purchase_order_amendments_request_immutable BEFORE UPDATE ON procurement_purchase_order_amendments
      BEGIN SELECT RAISE(ABORT,'immutable amendment request'); END;
    `)],
    ['criticality', (db: DatabaseSync) => db.exec(`
      DROP TABLE procurement_supplier_operating_profiles;
      CREATE TABLE procurement_supplier_operating_profiles (
        tenant_id TEXT NOT NULL,supplier_id TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
        country_code TEXT NOT NULL DEFAULT '' CHECK(country_code='' OR country_code GLOB '[A-Z][A-Z]'),route TEXT NOT NULL CHECK(route IN ('local','import','unclassified')),
        supplier_type TEXT NOT NULL CHECK(supplier_type IN ('manufacturer','distributor','service','other')),industry TEXT NOT NULL DEFAULT '',
        address_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(address_json) AND json_type(address_json) IN ('null','object')),
        primary_material_code TEXT NOT NULL DEFAULT '',primary_material_name TEXT NOT NULL DEFAULT '',default_lead_time_days INTEGER CHECK(default_lead_time_days IS NULL OR default_lead_time_days>=0),
        product_criticality TEXT NOT NULL CHECK(product_criticality IN ('high','medium','low')),payment_terms TEXT NOT NULL DEFAULT '',
        contract_starts_on TEXT CHECK(contract_starts_on IS NULL OR date(contract_starts_on)=contract_starts_on),contract_ends_on TEXT CHECK(contract_ends_on IS NULL OR date(contract_ends_on)=contract_ends_on),
        status TEXT NOT NULL CHECK(status IN ('active','inactive')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,supplier_id));
      CREATE INDEX idx_procurement_supplier_operating_profiles_route ON procurement_supplier_operating_profiles(tenant_id,route,status,supplier_id);
      CREATE TRIGGER trg_procurement_supplier_operating_profiles_valid_address_insert BEFORE INSERT ON procurement_supplier_operating_profiles
      BEGIN SELECT RAISE(ABORT,'invalid supplier address'); END;
      CREATE TRIGGER trg_procurement_supplier_operating_profiles_valid_address_update BEFORE UPDATE OF address_json ON procurement_supplier_operating_profiles
      BEGIN SELECT RAISE(ABORT,'invalid supplier address'); END;
    `)],
  ] as const) {
    const store = openPersistence(':memory:', { tenantId: `tenant:check-drift:${name}` });
    try {
      mutate(store.db);
      assert.throws(() => runMigrations(store.db), /migration 49.*constraint|missing|fingerprint/u, name);
    } finally { store.close(); }
  }
});

test('recorded migration 49 rejects same-name weak triggers and previously unvalidated snapshot constraints', () => {
  for (const [name, mutate] of [
    ['weak immutable trigger', (db: DatabaseSync) => db.exec(`
      DROP TRIGGER trg_procurement_purchase_order_amendments_request_immutable;
      CREATE TRIGGER trg_procurement_purchase_order_amendments_request_immutable
      BEFORE UPDATE OF po_id ON procurement_purchase_order_amendments
      BEGIN SELECT RAISE(ABORT,'immutable amendment request'); END;
    `)],
    ['weak snapshot hash constraint', (db: DatabaseSync) => db.exec(`
      DROP TABLE procurement_purchase_order_document_snapshots;
      CREATE TABLE procurement_purchase_order_document_snapshots (
        tenant_id TEXT NOT NULL,id TEXT NOT NULL,po_id TEXT NOT NULL,document_id TEXT NOT NULL,
        snapshot_kind TEXT NOT NULL CHECK(snapshot_kind IN ('purchase_order','amendment','cancellation')),
        source_po_version INTEGER NOT NULL CHECK(source_po_version>=1),context_watermark TEXT NOT NULL,template_version INTEGER NOT NULL CHECK(template_version>=1),
        content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),object_key TEXT NOT NULL,size_bytes INTEGER NOT NULL CHECK(size_bytes>=0),
        generated_by TEXT NOT NULL,generated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,document_id));
      CREATE INDEX idx_procurement_purchase_order_document_snapshots_po ON procurement_purchase_order_document_snapshots(tenant_id,po_id,generated_at,id);
      CREATE TRIGGER trg_procurement_purchase_order_document_snapshots_no_update BEFORE UPDATE ON procurement_purchase_order_document_snapshots
      BEGIN SELECT RAISE(ABORT,'purchase order document snapshots are append-only'); END;
      CREATE TRIGGER trg_procurement_purchase_order_document_snapshots_no_delete BEFORE DELETE ON procurement_purchase_order_document_snapshots
      BEGIN SELECT RAISE(ABORT,'purchase order document snapshots are append-only'); END;
    `)],
  ] as const) {
    const store = openPersistence(':memory:', { tenantId: `tenant:fingerprint:${name}` });
    try {
      mutate(store.db);
      assert.throws(() => runMigrations(store.db), /migration 49.*fingerprint|schema/u, name);
    } finally { store.close(); }
  }
});

test('migration 49 is serialized across two processes sharing one database', async () => {
  const fixture = tempDatabase('readywork-clean-room-v2-concurrent-');
  try {
    const gate = new DatabaseSync(fixture.path);
    gate.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); BEGIN IMMEDIATE');
    const startAt = Date.now() + 1_200;
    const pending = [concurrentOpen(fixture.path, startAt), concurrentOpen(fixture.path, startAt)];
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    gate.exec('COMMIT'); gate.close();
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join('\n'));
    assert.deepEqual(results.map((result) => result.stdout), [migrationName, migrationName]);
    const db = new DatabaseSync(fixture.path);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=49').get() as { count: number }).count, 1);
    db.close();
  } finally { fixture.cleanup(); }
});
