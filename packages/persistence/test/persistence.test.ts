import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { InMemoryAgentAdapter } from '@readywork/agent';
import { InMemoryContextStore } from '@readywork/context';
import type { EmployeeSpec } from '@readywork/core';
import { createRuntimeHub, emptyStats, nowIso } from '@readywork/core';
import { SkillRegistry } from '@readywork/skills';
import { ToolRegistry } from '@readywork/tools';
import { WorkflowEngine } from '@readywork/workflow';
import {
  attachPersistence,
  createPersistentRuntimeHub,
  normalizeInterruptedTasks,
  openPersistence,
  persistOrg,
  restoreOrgState,
  runMigrations,
} from '@readywork/persistence';

function tmpDb(): { dir: string; dbPath: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'rw-persist-test-'));
  return { dir, dbPath: join(dir, 't.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function concurrentOpen(dbPath: string, startAt: number, alterBarrierDir = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const source = `
    import { readdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { DatabaseSync } from 'node:sqlite';
    import { openPersistence } from '@readywork/persistence';
    const [dbPath, startAt, alterBarrierDir] = process.argv.slice(1);
    if (alterBarrierDir) {
      const originalPrepare = DatabaseSync.prototype.prepare;
      let controlColumnChecks = 0;
      DatabaseSync.prototype.prepare = function (sql) {
        const statement = originalPrepare.call(this, sql);
        if (String(sql).includes('PRAGMA table_info(procurement_advanced_sla_runtime_controls)')) {
          const originalAll = statement.all;
          statement.all = function (...args) {
            const rows = originalAll.apply(this, args);
            if (!rows.some((row) => row.name === 'profile_version')) {
              const round = ++controlColumnChecks;
              writeFileSync(join(alterBarrierDir, String(process.pid) + '-' + String(round)), 'ready');
              const deadline = Date.now() + 750;
              while (Date.now() < deadline && readdirSync(alterBarrierDir).filter((name) => name.endsWith('-' + String(round))).length < 2) {}
            }
            return rows;
          };
        }
        return statement;
      };
    }
    while (Date.now() < Number(startAt)) {}
    const store = openPersistence(dbPath, { tenantId: 'tenant:concurrent-start' });
    process.stdout.write(String(store.db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count));
    store.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source, dbPath, String(startAt), alterBarrierDir], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function registerOrg(hub: ReturnType<typeof createRuntimeHub>): void {
  hub.org.registerTenant({ id: 't1', name: '测试' });
  hub.org.registerDepartment({ id: 'd1', tenantId: 't1', name: '采购部' });
  hub.org.registerHuman({ id: 'h:manager', tenantId: 't1', deptId: 'd1', name: '经理', email: 'm@t.cn', role: '经理' });
  hub.org.registerAI({
    id: 'ai:test',
    tenantId: 't1',
    deptId: 'd1',
    specId: 'spec:test',
    name: '测试员工',
    role: '测试',
    status: 'idle',
    managerId: 'h:manager',
    stats: emptyStats(),
    createdAt: nowIso(),
  });
  const spec: EmployeeSpec = {
    id: 'spec:test',
    name: '测试员工',
    departmentId: 'd1',
    version: '1',
    role: '测试',
    goals: [],
    workers: ['w1'],
    workflows: ['wf'],
    skills: [],
    tools: ['fake'],
    permissions: [{ effect: 'allow', action: '*', resource: '*' }],
    policies: [],
    approvalRules: [],
    budget: { monthlyCap: 100, currency: 'CNY' },
    contextScope: [],
    evalCriteria: [],
    humanEscalation: { contactIds: [] },
  };
  hub.specs.register(spec);
}

function makeEngine(hub: ReturnType<typeof createRuntimeHub>) {
  const context = new InMemoryContextStore();
  const skills = new SkillRegistry();
  const tools = new ToolRegistry();
  const agent = new InMemoryAgentAdapter({ defaultHandler: (req) => ({ reasoning: req.instruction, actions: [], stateUpdates: {} }) });
  const engine = new WorkflowEngine({ hub, agent, skills, tools, context });
  engine.register({
    id: 'wf',
    name: '测试流',
    steps: [
      { type: 'wait', reason: '等外部事件', forEvent: { eventType: 'supplier_replied', objectId: '{{bo.id}}' }, untilMs: 60_000 },
      { type: 'end' },
    ],
  });
  return engine;
}

test('持久化: 仓储 round-trip（task/object/approval/event/budget/org）', () => {
  const t = tmpDb();
  try {
    const store = openPersistence(t.dbPath);
    store.tasks.save({
      id: 'task:1',
      tenantId: 't1',
      employeeId: 'ai:test',
      workflowId: 'wf',
      businessObjectId: 'bo:1',
      status: 'waiting_external',
      attempts: 0,
      maxRetries: 3,
      checkpoint: { stepIndex: 2, workspace: { x: 1 } },
      createdAt: nowIso(),
      metadata: {},
    });
    assert.equal(store.tasks.get('task:1')?.checkpoint.workspace['x'], 1);
    assert.equal(store.tasks.list('waiting_external').length, 1);
    const saved = store.tasks.get('task:1')!;
    saved.status = 'completed';
    store.tasks.save(saved);
    assert.equal(store.tasks.get('task:1')?.status, 'completed');
    assert.equal(store.tasks.list('waiting_external').length, 0);

    store.objects.save({
      id: 'bo:1',
      type: 'po',
      status: 'sent',
      attributes: { promiseDate: '2025-08-25' },
      state: {},
      history: [],
      updatedAt: nowIso(),
    });
    assert.equal(store.objects.get('bo:1')?.attributes['promiseDate'], '2025-08-25');

    store.approvals.save({
      id: 'appr:1',
      taskId: 'task:1',
      ruleId: 'r1',
      title: '审批',
      message: '',
      payload: { days: 11 },
      status: 'pending',
      requestedAt: nowIso(),
    });
    assert.equal(store.approvals.listPending().length, 1);

    store.events.append({ type: 'task.created', taskId: 'task:1', employeeId: 'ai:test', workflowId: 'wf', at: nowIso() });
    store.events.append({ type: 'task.completed', taskId: 'task:1', employeeId: 'ai:test', at: nowIso() });
    assert.equal(store.events.list().length, 2);
    assert.equal(store.events.list(1).length, 1);
    assert.equal(store.events.list(1)[0]!.type, 'task.completed');

    store.budget.save({ employeeId: 'ai:test', monthlyCap: 100, currency: 'CNY', month: '2025-08', spent: 12.5 });
    assert.equal(store.budget.get('ai:test')?.spent, 12.5);

    store.org.save({ kind: 'ai', id: 'ai:test', json: '{"id":"ai:test"}' });
    assert.equal(store.org.get('ai', 'ai:test')?.json, '{"id":"ai:test"}');

    store.close();
  } finally {
    t.cleanup();
  }
});

test('持久化: 崩溃恢复 —— waiting 任务跨重启恢复并完成', async () => {
  const t = tmpDb();
  try {
    // 第一次运行：任务停在 waiting_external
    const store1 = openPersistence(t.dbPath);
    const hub1 = createPersistentRuntimeHub(store1);
    registerOrg(hub1);
    persistOrg(store1, hub1);
    attachPersistence(store1, hub1);
    const bo = hub1.objects.create({ id: 'bo:1', type: 'po', status: 'sent', attributes: { x: 1 } });
    const engine1 = makeEngine(hub1);
    const task = await engine1.runTask({ tenantId: 't1', employeeId: 'ai:test', workflowId: 'wf', businessObjectId: bo.id });
    assert.equal(task.status, 'waiting_external');
    const emp1 = hub1.org.getAI('ai:test')!;
    assert.equal(emp1.status, 'waiting_external');
    hub1.scheduler.cancelAll(); // 模拟进程崩溃：定时器随进程消亡
    store1.close(); // 模拟崩溃

    // 重启
    const store2 = openPersistence(t.dbPath);
    const hub2 = createPersistentRuntimeHub(store2);
    registerOrg(hub2);
    restoreOrgState(store2, hub2);
    const engine2 = makeEngine(hub2);
    assert.equal(engine2.rearmWaits(), 1, '应重新武装等待事件');
    assert.equal(hub2.machine.get(task.id)?.status, 'waiting_external');
    assert.equal(hub2.org.getAI('ai:test')?.status, 'waiting_external', '员工状态应恢复');
    assert.ok(hub2.eventLog.some((e) => e.type === 'task.waiting'), '事件日志应回灌');

    hub2.bus.emit({ type: 'context.event', eventType: 'supplier_replied', objectId: 'bo:1', at: nowIso() });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hub2.machine.get(task.id)?.status, 'completed');
    assert.equal(hub2.org.getAI('ai:test')?.stats.tasksCompleted, 1);
    store2.close();
  } finally {
    t.cleanup();
  }
});

test('持久化: 中断任务（重启时 running）被标记 failed', () => {
  const t = tmpDb();
  try {
    const store1 = openPersistence(t.dbPath);
    const hub1 = createPersistentRuntimeHub(store1);
    registerOrg(hub1);
    const task = hub1.machine.create({ tenantId: 't1', employeeId: 'ai:test', workflowId: 'wf', businessObjectId: 'bo:1' });
    hub1.machine.start(task.id);
    assert.equal(hub1.machine.get(task.id)?.status, 'running');
    store1.close();

    const store2 = openPersistence(t.dbPath);
    const hub2 = createPersistentRuntimeHub(store2);
    // createPersistentRuntimeHub 内部已规范化中断任务
    const restored = hub2.machine.get(task.id)!;
    assert.equal(restored.status, 'failed');
    assert.ok(restored.error?.includes('进程中断'));
    assert.equal(hub2.taskRepo.list('running').length, 0, '不应残留 running 任务');
    store2.close();
  } finally {
    t.cleanup();
  }
});

test('持久化: 相同业务 ID 在不同租户间完全隔离', () => {
  const t = tmpDb();
  try {
    const tenantA = openPersistence(t.dbPath, { tenantId: 'tenant:a' });
    const tenantB = openPersistence(t.dbPath, { tenantId: 'tenant:b' });
    tenantA.objects.save({ id: 'po:same', type: 'po', status: 'draft', attributes: { owner: 'A' }, state: {}, history: [], updatedAt: nowIso() });
    tenantB.objects.save({ id: 'po:same', type: 'po', status: 'draft', attributes: { owner: 'B' }, state: {}, history: [], updatedAt: nowIso() });
    assert.equal(tenantA.objects.get('po:same')?.attributes['owner'], 'A');
    assert.equal(tenantB.objects.get('po:same')?.attributes['owner'], 'B');
    tenantA.events.append({ type: 'context.event', eventType: 'tenant-a-only', at: nowIso() });
    assert.equal(tenantA.events.list().length, 1);
    assert.equal(tenantB.events.list().length, 0);
    tenantA.close();
    tenantB.close();
  } finally {
    t.cleanup();
  }
});

test('持久化: 版本化迁移保留旧表数据', () => {
  const t = tmpDb();
  try {
    const first = openPersistence(t.dbPath, { tenantId: 'tenant:legacy' });
    first.db.prepare('INSERT INTO business_objects (id,type,json,updated_at) VALUES (?,?,?,?)').run('legacy:po', 'po', JSON.stringify({ id: 'legacy:po', type: 'po', status: 'sent', attributes: { migrated: true }, state: {}, history: [], updatedAt: nowIso() }), nowIso());
    first.close();
    const restored = openPersistence(t.dbPath, { tenantId: 'tenant:legacy' });
    assert.equal(restored.objects.get('legacy:po')?.attributes['migrated'], true);
    const versions = restored.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    assert.deepEqual(versions.map((row) => row.version), Array.from({ length: 56 }, (_, index) => index + 1));
    const migration35 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(35) as { name: string };
    assert.equal(migration35.name, 'manufacturing-context-twin');
    const migration36 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(36) as { name: string };
    assert.equal(migration36.name, 'procurement-line-projection-generations');
    const migration37 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(37) as { name: string };
    assert.equal(migration37.name, 'manufacturing-context-worker-heartbeats');
    const migration38 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(38) as { name: string };
    assert.equal(migration38.name, 'procurement-advanced-sla');
    const migration39 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(39) as { name: string };
    assert.equal(migration39.name, 'procurement-tenant-preferences');
    const migration40 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(40) as { name: string };
    assert.equal(migration40.name, 'procurement-po-context-chat');
    const migration41 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(41) as { name: string };
    assert.equal(migration41.name, 'procurement-inbound-mail-rejection-evidence');
    const migration42 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(42) as { name: string };
    assert.equal(migration42.name, 'procurement-realtime-event-feed');
    const migration43 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(43) as { name: string };
    assert.equal(migration43.name, 'procurement-material-lead-times');
    const migration44 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(44) as { name: string };
    assert.equal(migration44.name, 'procurement-route-evidence-documents');
    const migration45 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(45) as { name: string };
    assert.equal(migration45.name, 'public-demo-requests');
    const migration46 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(46) as { name: string };
    assert.equal(migration46.name, 'procurement-general-settings-policies');
    const migration47 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(47) as { name: string };
    assert.equal(migration47.name, 'procurement-route-context-chat');
    const migration48 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(48) as { name: string };
    assert.equal(migration48.name, 'procurement-route-chat-attachments');
    const migration49 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(49) as { name: string };
    assert.equal(migration49.name, 'navisight-clean-room-alignment-v2');
    const migration50 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(50) as { name: string };
    assert.equal(migration50.name, 'procurement-material-lead-time-criticality');
    const migration51 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(51) as { name: string };
    assert.equal(migration51.name, 'procurement-ai-supplier-reply-analysis');
    const migration52 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(52) as { name: string };
    assert.equal(migration52.name, 'procurement-route-assignment-idempotency');
    const migration53 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(53) as { name: string };
    assert.equal(migration53.name, 'messaging-gateway-boundaries');
    const migration54 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(54) as { name: string };
    assert.equal(migration54.name, 'messaging-durable-inputs-and-lifecycle');
    const migration55 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(55) as { name: string };
    assert.equal(migration55.name, 'messaging-dynamic-channel-identifiers');
    const migration56 = restored.db.prepare('SELECT name FROM schema_migrations WHERE version=?').get(56) as { name: string };
    assert.equal(migration56.name, 'hermes-gateway-integration');
    const routeAssignmentIdempotencyColumns = restored.db.prepare('PRAGMA table_info(procurement_route_assignment_idempotency)').all() as Array<{ name: string; pk: number }>;
    assert.deepEqual(routeAssignmentIdempotencyColumns.map((column) => column.name), [
      'tenant_id', 'idempotency_key', 'payload_hash', 'response_json', 'created_at',
    ]);
    assert.deepEqual(routeAssignmentIdempotencyColumns.map((column) => column.pk), [1, 2, 0, 0, 0]);
    const routeChatColumns = restored.db.prepare('PRAGMA table_info(procurement_route_chat_messages)').all() as Array<{ name: string }>;
    assert.equal(routeChatColumns.some((column) => column.name === 'attachment_id'), true);
    const preferenceColumns = restored.db.prepare('PRAGMA table_info(procurement_tenant_preferences)').all() as Array<{ name: string }>;
    for (const column of ['sla_escalations_enabled', 'exclude_weekends', 'exclude_public_holidays', 'auto_calculate_lead_time']) {
      assert.equal(preferenceColumns.some((item) => item.name === column), true, `procurement_tenant_preferences.${column}`);
    }
    const rejectionColumns = restored.db.prepare('PRAGMA table_info(procurement_inbound_mail_rejections)').all() as Array<{ name: string }>;
    assert.equal(rejectionColumns.some((column) => column.name === 'observed_sender'), true);
    for (const table of ['procurement_po_chat_conversations', 'procurement_po_chat_messages', 'procurement_po_chat_requests', 'procurement_po_chat_audit']) {
      assert.equal(Boolean(restored.db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)), true, table);
    }
    for (const table of ['procurement_route_chat_conversations', 'procurement_route_chat_messages', 'procurement_route_chat_requests', 'procurement_route_chat_audit']) {
      assert.equal(Boolean(restored.db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)), true, table);
    }
    for (const table of ['procurement_tenant_preferences', 'procurement_tenant_preference_events']) {
      assert.equal(Boolean(restored.db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)), true, table);
    }
    for (const table of ['procurement_material_lead_times', 'procurement_material_lead_time_events']) {
      assert.equal(Boolean(restored.db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)), true, table);
    }
    for (const table of ['procurement_route_evidence_documents', 'procurement_route_evidence_document_events', 'procurement_route_evidence_document_idempotency']) {
      assert.equal(Boolean(restored.db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)), true, table);
    }
    for (const table of ['public_demo_requests', 'public_demo_request_events']) {
      assert.equal(Boolean(restored.db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)), true, table);
    }
    const advancedObjects = restored.db.prepare(`SELECT name,type FROM sqlite_master WHERE name LIKE 'procurement_advanced_sla_%' ORDER BY name`).all() as Array<{ name: string; type: string }>;
    for (const table of ['procurement_advanced_sla_profiles', 'procurement_advanced_sla_profile_events', 'procurement_advanced_sla_runtime_controls', 'procurement_advanced_sla_runtime_events', 'procurement_advanced_sla_import_batches']) assert.equal(advancedObjects.some((item) => item.type === 'table' && item.name === table), true, table);
    assert.equal(Boolean(restored.db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='uq_procurement_advanced_sla_published'").get()), true);
    const profileColumns = restored.db.prepare('PRAGMA table_info(procurement_advanced_sla_profiles)').all() as Array<{ name: string }>;
    assert.equal(profileColumns.some((column) => column.name === 'description'), true);
    for (const table of ['procurement_advanced_sla_runtime_controls', 'procurement_advanced_sla_runtime_events']) {
      const columns = restored.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      assert.equal(columns.some((column) => column.name === 'profile_version'), true, `${table}.profile_version`);
    }
    const batchColumns = restored.db.prepare('PRAGMA table_info(procurement_advanced_sla_import_batches)').all() as Array<{ name: string }>;
    for (const column of ['source_name', 'error_json', 'updated_at']) assert.equal(batchColumns.some((item) => item.name === column), true, `import_batches.${column}`);
    const lineColumns = restored.db.prepare('PRAGMA table_info(procurement_lines)').all() as Array<{ name: string }>;
    assert.equal(lineColumns.some((column) => column.name === 'projection_generation'), true);
    restored.close();
  } finally {
    t.cleanup();
  }
});

test('持久化: 两个进程并发打开同一个全新数据库时每个迁移只记录一次', async () => {
  const t = tmpDb();
  try {
    const migrationGate = new DatabaseSync(t.dbPath);
    migrationGate.exec('PRAGMA journal_mode = WAL');
    migrationGate.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    migrationGate.exec('BEGIN IMMEDIATE');
    const startAt = Date.now() + 1_500;
    const pending = [concurrentOpen(t.dbPath, startAt), concurrentOpen(t.dbPath, startAt)];
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    migrationGate.exec('COMMIT');
    migrationGate.close();
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join('\n'));
    assert.deepEqual(results.map((result) => result.stdout), ['56', '56']);
    const db = new DatabaseSync(t.dbPath);
    try {
      const rows = db.prepare('SELECT version,name,COUNT(*) AS count FROM schema_migrations GROUP BY version,name ORDER BY version').all() as Array<{ version: number; name: string; count: number }>;
      assert.deepEqual(rows.map((row) => row.version), Array.from({ length: 56 }, (_, index) => index + 1));
      assert.equal(rows.every((row) => row.count === 1), true);
      assert.equal(rows.find((row) => row.version === 38)?.name, 'procurement-advanced-sla');
      assert.equal(rows.find((row) => row.version === 39)?.name, 'procurement-tenant-preferences');
      assert.equal(rows.find((row) => row.version === 40)?.name, 'procurement-po-context-chat');
      assert.equal(rows.find((row) => row.version === 41)?.name, 'procurement-inbound-mail-rejection-evidence');
      assert.equal(rows.find((row) => row.version === 42)?.name, 'procurement-realtime-event-feed');
      assert.equal(rows.find((row) => row.version === 43)?.name, 'procurement-material-lead-times');
      assert.equal(rows.find((row) => row.version === 44)?.name, 'procurement-route-evidence-documents');
      assert.equal(rows.find((row) => row.version === 45)?.name, 'public-demo-requests');
      assert.equal(rows.find((row) => row.version === 47)?.name, 'procurement-route-context-chat');
      assert.equal(rows.find((row) => row.version === 48)?.name, 'procurement-route-chat-attachments');
      assert.equal(rows.find((row) => row.version === 49)?.name, 'navisight-clean-room-alignment-v2');
      assert.equal(rows.find((row) => row.version === 50)?.name, 'procurement-material-lead-time-criticality');
      assert.equal(rows.find((row) => row.version === 53)?.name, 'messaging-gateway-boundaries');
      assert.equal(rows.find((row) => row.version === 54)?.name, 'messaging-durable-inputs-and-lifecycle');
      assert.equal(rows.find((row) => row.version === 55)?.name, 'messaging-dynamic-channel-identifiers');
      assert.equal(rows.find((row) => row.version === 56)?.name, 'hermes-gateway-integration');
    } finally {
      db.close();
    }
  } finally {
    t.cleanup();
  }
});

test('持久化: 两个进程并发修复已记录 migration 38 的旧 schema 时只使用证据版本或 NULL', async () => {
  const t = tmpDb();
  const tenantId = 'tenant:legacy-v38-concurrent';
  const profileId = 'advanced-sla:legacy-concurrent';
  const alterBarrierDir = join(t.dir, 'alter-barrier');
  try {
    mkdirSync(alterBarrierDir);
    const current = openPersistence(t.dbPath, { tenantId });
    current.close();
    const legacy = new DatabaseSync(t.dbPath);
    legacy.exec('ALTER TABLE procurement_advanced_sla_runtime_controls DROP COLUMN profile_version');
    legacy.exec('ALTER TABLE procurement_advanced_sla_runtime_events DROP COLUMN profile_version');
    legacy.prepare(`INSERT INTO procurement_advanced_sla_profiles
      (tenant_id,id,name,description,status,version,sections_json,auto_send_json,created_by,updated_by,published_by,created_at,updated_at,published_at)
      VALUES (?,?,?,'legacy concurrent repair','published',4,'[]','{"enabled":false,"stages":[],"channels":[],"risks":[]}','manager','manager','manager',?,?,?)`).run(
      tenantId, profileId, 'Legacy concurrent profile', '2026-08-30T06:00:00.000Z', '2026-08-30T06:00:00.000Z', '2026-08-30T06:00:00.000Z',
    );
    legacy.prepare(`INSERT INTO procurement_advanced_sla_runtime_controls
      (tenant_id,profile_id,paused,version,updated_by,updated_at) VALUES (?,?,0,3,'manager','2026-08-30T06:00:00.000Z')`).run(tenantId, profileId);
    legacy.prepare(`INSERT INTO procurement_advanced_sla_runtime_events
      (tenant_id,id,profile_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,'manager','auto_send_decision',?,'2026-08-30T06:00:00.000Z')`).run(
      tenantId, 'runtime-event:concurrent-exact', profileId, JSON.stringify({ profileId, profileVersion: 4, decisionCode: 'auto_send_disabled' }),
    );
    legacy.prepare(`INSERT INTO procurement_advanced_sla_runtime_events
      (tenant_id,id,profile_id,actor_id,action,detail_json,created_at) VALUES (?,?,?,'manager','paused','{"controlVersion":2}','2026-08-30T06:01:00.000Z')`).run(
      tenantId, 'runtime-event:concurrent-unknown', profileId,
    );
    legacy.close();

    const startAt = Date.now() + 1_500;
    const pending = [concurrentOpen(t.dbPath, startAt, alterBarrierDir), concurrentOpen(t.dbPath, startAt, alterBarrierDir)];
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join('\n'));

    const repaired = new DatabaseSync(t.dbPath);
    try {
      const control = repaired.prepare('SELECT profile_version,paused,version FROM procurement_advanced_sla_runtime_controls WHERE tenant_id=? AND profile_id=?').get(tenantId, profileId) as { profile_version: number | null; paused: number; version: number };
      assert.deepEqual({ ...control }, { profile_version: 4, paused: 0, version: 3 });
      const events = repaired.prepare('SELECT id,profile_version FROM procurement_advanced_sla_runtime_events WHERE tenant_id=? ORDER BY id').all(tenantId) as Array<{ id: string; profile_version: number | null }>;
      assert.deepEqual(events.map((event) => ({ ...event })), [
        { id: 'runtime-event:concurrent-exact', profile_version: 4 },
        { id: 'runtime-event:concurrent-unknown', profile_version: null },
      ]);
    } finally {
      repaired.close();
    }
  } finally {
    t.cleanup();
  }
});

test('持久化: 已记录的迁移版本名称冲突不得被并发重检吞掉', () => {
  const db = new DatabaseSync(':memory:');
  try {
    runMigrations(db);
    db.prepare('UPDATE schema_migrations SET name=? WHERE version=38').run('conflicting-advanced-sla');
    assert.throws(() => runMigrations(db), /migration 38.*name conflict/i);
  } finally {
    db.close();
  }
});

test('持久化: 已记录 migration 38 的修复 SQL 错误必须回滚并传播', () => {
  const db = new DatabaseSync(':memory:');
  try {
    runMigrations(db);
    db.exec('DROP TABLE procurement_advanced_sla_runtime_controls');
    assert.throws(() => runMigrations(db), /no such table: procurement_advanced_sla_runtime_controls/i);
    const migration38 = db.prepare('SELECT name FROM schema_migrations WHERE version=38').get() as { name: string };
    assert.equal(migration38.name, 'procurement-advanced-sla');
  } finally {
    db.close();
  }
});
