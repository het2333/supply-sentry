import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PROCUREMENT_EMPLOYEE_PACK } from '@readywork/supply-chain';
import { EditorStore, legacyEditorWorkflows } from '../src/editor.js';
import { EditorStoreRegistry } from '../src/editor-registry.js';

function installLegacyInvoiceMatchDraft(db: DatabaseSync, editor: EditorStore): ReturnType<EditorStore['getWorkflow']> {
  const current = legacyEditorWorkflows().find((workflow) => workflow.id === 'invoice-match')!;
  db.prepare('INSERT OR REPLACE INTO control_workflow_drafts (tenant_id, employee_id, workflow_id, json, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('tenant:jinggong', 'ai:procurement', current.id, JSON.stringify(current), current.updatedAt);
  return editor.getWorkflow(current.id);
}

function saveLegacyInvoiceMatchDraft(db: DatabaseSync, editor: EditorStore, name = '旧版发票三单匹配'): ReturnType<EditorStore['saveWorkflow']> {
  const current = installLegacyInvoiceMatchDraft(db, editor)!;
  const legacyMatch = current.nodes.find((node) => node.id === 'match:line')!;
  const userNode = { ...current.nodes.find((node) => node.id === 'x:pay')!, id: 'user:keep', name: '用户自定义节点', label: '用户自定义节点', detail: '升级时必须保留' };
  const nodes = current.nodes
    .filter((node) => node.id !== 'match:line')
    .concat({ ...legacyMatch, id: 'ai:tw', kind: 'ai', name: '三单匹配（旧版）', label: '三单匹配（旧版）', detail: '旧版总额三单核对', type: 'ai.three_way_match' }, userNode);
  const edges = current.edges
    .filter((edge) => edge.from !== 'match:line' && edge.to !== 'match:line')
    .concat(
      { from: 'logic:link', to: 'ai:tw' },
      { from: 'ai:tw', to: 'x:pay', label: '差异在容差内' },
      { from: 'ai:tw', to: 'appr:tw', label: '差异超限' },
    );
  return editor.saveWorkflow(current.id, { ...current, name, nodes, edges, expectedRevision: current.draftRevision });
}

test('Editor: 工作流保存、发布与回滚持久化', () => {
  const db = new DatabaseSync(':memory:');
  const editor = new EditorStore(db);
  assert.equal(editor.listWorkflows().length, 3);
  assert.equal(editor.catalog().aiCapabilities, 4);
  assert.deepEqual(editor.listWorkflows().map((workflow) => workflow.id), PROCUREMENT_EMPLOYEE_PACK.assets.workflowIds);
  assert.deepEqual(
    new Set(editor.catalog().nodeTypes.map((descriptor) => descriptor.type)),
    new Set(PROCUREMENT_EMPLOYEE_PACK.assets.nodeTypeIds),
  );
  const archivedInvoice = installLegacyInvoiceMatchDraft(db, editor)!;
  assert.equal(editor.listWorkflows().some((workflow) => workflow.id === archivedInvoice.id), false);

  const current = editor.getWorkflow('po-operations')!;
  assert.equal(current.nodes.every((node) => Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y)), true);
  assert.equal(current.edges.every((edge) => Boolean(edge.id)), true);
  const changed = editor.saveWorkflow(current.id, {
    ...current,
    expectedRevision: current.draftRevision,
    nodes: current.nodes.map((node) => node.id === 'logic:delay' ? { ...node, label: '延期规则判断' } : node),
  });
  assert.equal(changed.draftRevision, 2);
  assert.equal(changed.publishedRevision, 1);

  const moved = editor.saveWorkflow(current.id, {
    ...changed,
    expectedRevision: changed.draftRevision,
    nodes: changed.nodes.map((node) => node.id === 'logic:delay' ? { ...node, position: { x: 777, y: 333 } } : node),
    edges: changed.edges.map((edge, index) => index === 0 ? { ...edge, label: '事件进入', sourcePort: '事件事实快照' } : edge),
  });
  assert.deepEqual(moved.nodes.find((node) => node.id === 'logic:delay')!.position, { x: 777, y: 333 });
  assert.equal(moved.edges[0]!.label, '事件进入');

  const published = editor.publish('回归测试发布');
  assert.equal(published.version.version, 'v1.0.1');
  assert.equal(published.workflows[0]!.draftRevision, published.workflows[0]!.publishedRevision);

  const rollback = editor.rollback('v1.0.0');
  assert.equal(rollback.version.version, 'v1.0.2');
  assert.equal(rollback.sourceVersion, 'v1.0.0');
  assert.equal(editor.getWorkflow('po-operations')!.nodes.find((node) => node.id === 'logic:delay')!.label, '交期异常判断');
  assert.equal(editor.getWorkflow(archivedInvoice.id)?.name, archivedInvoice.name, '发布和回滚不得删除历史草稿');
  db.close();
});

test('Editor: V1 不新建发票流程，但历史发票草稿仍可读取且不进入活动列表', () => {
  const db = new DatabaseSync(':memory:');
  const editor = new EditorStore(db);
  assert.equal(editor.getWorkflow('invoice-match'), undefined);
  const invoiceMatch = installLegacyInvoiceMatchDraft(db, editor)!;
  assert.equal(editor.listWorkflows().some((workflow) => workflow.id === 'invoice-match'), false);
  const lineMatch = invoiceMatch.nodes.find((node) => node.id === 'match:line')!;

  assert.equal(lineMatch.kind, 'action');
  assert.equal(lineMatch.label, '行级三单匹配');
  assert.equal(lineMatch.type, 'business.procurement_line_match');
  assert.equal(invoiceMatch.nodes.some((node) => node.type === 'ai.three_way_match'), false);
  assert.deepEqual(
    invoiceMatch.edges.filter((edge) => edge.from === 'match:line').map((edge) => edge.label).sort(),
    ['完全匹配', '容差内', '需要审批', '严重异常'].sort(),
  );
  assert.equal(invoiceMatch.edges.some((edge) => edge.from === 'appr:tw' && edge.to === 'x:pay' && edge.label === '批准后恢复'), true);
  assert.equal(invoiceMatch.edges.some((edge) => edge.from === 'match:line' && edge.to === 'x:exception' && edge.label === '严重异常'), true);
  assert.equal(invoiceMatch.nodes.find((node) => node.id === 'x:pay')!.detail, '应付审核完成/标记可付款');
  const erpWrite = invoiceMatch.nodes.find((node) => node.id === 'erp:pay')!;
  assert.equal(erpWrite.kind, 'tool');
  assert.equal(erpWrite.label, 'ERP回写应付结果');
  assert.equal(erpWrite.type, 'connector.erp.action');
  assert.deepEqual(erpWrite.sideEffects, ['写 ERP']);
  assert.equal(invoiceMatch.edges.some((edge) => edge.from === 'x:pay' && edge.to === 'erp:pay'), true);
  assert.equal(invoiceMatch.edges.some((edge) => edge.from === 'erp:pay' && edge.to === 'n:inv'), true);
  assert.equal(invoiceMatch.edges.some((edge) => edge.from === 'x:exception' && edge.to === 'erp:pay'), false);

  const saved = editor.saveWorkflow(invoiceMatch.id, { ...invoiceMatch, expectedRevision: invoiceMatch.draftRevision, name: '用户已编辑的发票匹配' });
  const reopened = new EditorStore(db);
  assert.equal(reopened.getWorkflow(invoiceMatch.id)!.name, saved.name);
  assert.equal(reopened.listWorkflows().some((workflow) => workflow.id === invoiceMatch.id), false);
  db.close();
});

test('Editor: 旧版发票匹配可预览并显式、幂等地升级，不覆盖用户节点', () => {
  const db = new DatabaseSync(':memory:');
  const editor = new EditorStore(db);
  const legacy = saveLegacyInvoiceMatchDraft(db, editor);

  const preview = editor.previewInvoiceMatchUpgrade(legacy.id);
  assert.equal(preview.status, 'eligible');
  assert.equal(preview.currentRevision, legacy.draftRevision);
  assert.deepEqual(editor.getWorkflow(legacy.id)!.nodes.find((node) => node.id === 'user:keep'), legacy.nodes.find((node) => node.id === 'user:keep'));
  assert.equal(preview.addedEdges.some((edge) => edge.label === '严重异常'), true);

  const upgraded = editor.upgradeInvoiceMatch(legacy.id, legacy.draftRevision);
  assert.equal(upgraded.status, 'upgraded');
  assert.equal(upgraded.workflow.draftRevision, legacy.draftRevision + 1);
  assert.equal(upgraded.workflow.nodes.find((node) => node.id === 'ai:tw')!.type, 'business.procurement_line_match');
  assert.deepEqual(
    upgraded.workflow.edges.filter((edge) => edge.from === 'ai:tw').map((edge) => edge.label).sort(),
    ['完全匹配', '容差内', '需要审批', '严重异常'].sort(),
  );
  const payableId = preview.addedNodeIds.find((id) => id.startsWith('upgrade:payable'))!;
  const approvalId = preview.addedNodeIds.find((id) => id.startsWith('upgrade:finance-approval'))!;
  const erpWriteId = preview.addedNodeIds.find((id) => id.startsWith('upgrade:erp-pay'))!;
  const exceptionId = preview.addedNodeIds.find((id) => id.startsWith('upgrade:exception'))!;
  assert.equal(upgraded.workflow.edges.some((edge) => edge.from === approvalId && edge.to === payableId && edge.label === '批准后恢复'), true);
  assert.equal(upgraded.workflow.edges.some((edge) => edge.from === payableId && edge.to === erpWriteId), true);
  assert.equal(upgraded.workflow.edges.some((edge) => edge.from === exceptionId && edge.to === erpWriteId), false);
  assert.equal(upgraded.workflow.nodes.find((node) => node.id === erpWriteId)!.type, 'connector.erp.action');
  assert.deepEqual(upgraded.workflow.nodes.find((node) => node.id === 'user:keep'), legacy.nodes.find((node) => node.id === 'user:keep'));

  const replay = editor.upgradeInvoiceMatch(legacy.id, legacy.draftRevision);
  assert.equal(replay.status, 'already_current');
  assert.equal(replay.workflow.draftRevision, upgraded.workflow.draftRevision);
  db.close();
});

test('Editor: 旧版发票匹配升级使用 expectedRevision 防止覆盖并发修改', () => {
  const db = new DatabaseSync(':memory:');
  const editor = new EditorStore(db);
  const legacy = saveLegacyInvoiceMatchDraft(db, editor, '等待升级的旧草稿');
  const concurrent = editor.saveWorkflow(legacy.id, { ...legacy, name: '另一位用户的修改', expectedRevision: legacy.draftRevision });

  assert.throws(() => editor.upgradeInvoiceMatch(legacy.id, legacy.draftRevision), /工作流版本冲突/);
  assert.equal(editor.getWorkflow(legacy.id)!.name, concurrent.name);
  assert.equal(editor.getWorkflow(legacy.id)!.nodes.some((node) => node.type === 'ai.three_way_match'), true);
  db.close();
});

test('Editor: 过期草稿不能覆盖较新的修改', () => {
  const db = new DatabaseSync(':memory:');
  const editor = new EditorStore(db);
  const base = editor.getWorkflow('po-operations')!;
  const first = editor.saveWorkflow(base.id, { ...base, expectedRevision: base.draftRevision, name: '客户端一的修改' });
  assert.equal(first.draftRevision, base.draftRevision + 1);
  assert.throws(
    () => editor.saveWorkflow(base.id, { ...base, expectedRevision: base.draftRevision, name: '过期客户端的修改' }),
    /工作流版本冲突/,
  );
  assert.equal(editor.getWorkflow(base.id)!.name, '客户端一的修改');
  db.close();
});

test('Editor: V1 蓝图先预览差异，再单事务备份并显式导入草稿', () => {
  const db = new DatabaseSync(':memory:');
  const editor = new EditorStore(db);
  const current = editor.getWorkflow('po-operations')!;
  const customNode = {
    ...current.nodes[0]!,
    id: 'user:custom-node',
    name: '用户自定义检查',
    label: '用户自定义检查',
    detail: '导入前必须进入完整备份',
    position: { x: 88, y: 688 },
  };
  const drifted = editor.saveWorkflow(current.id, {
    ...current,
    expectedRevision: current.draftRevision,
    nodes: current.nodes
      .map((node) => node.id === 'logic:delay' ? { ...node, label: '租户自定义交期判断' } : node)
      .concat(customNode),
  });
  const versionsBefore = editor.listVersions().length;
  const preview = editor.previewBlueprintUpgrade();
  const poDiff = preview.workflows.find((workflow) => workflow.workflowId === current.id)!;

  assert.equal(preview.status, 'upgrade_available');
  assert.equal(preview.createsBackup, true);
  assert.equal(poDiff.currentRevision, drifted.draftRevision);
  assert.equal(poDiff.removedNodeIds.includes(customNode.id), true);
  assert.equal(poDiff.changedNodeIds.includes('logic:delay'), true);

  const result = editor.importBlueprint({
    expectedRevisions: preview.expectedRevisions,
    idempotencyKey: 'blueprint-import:test:one',
    actorId: 'human:admin',
  });
  const imported = editor.getWorkflow(current.id)!;
  assert.equal(result.status, 'imported');
  assert.equal(imported.nodes.some((node) => node.id === customNode.id), false);
  assert.equal(imported.nodes.find((node) => node.id === 'logic:delay')!.label, '交期异常判断');
  assert.equal(imported.nodes.some((node) => node.id === 'mail:follow'), true);
  assert.equal(imported.draftRevision, drifted.draftRevision + 1);
  assert.equal(imported.publishedRevision, drifted.publishedRevision, '导入只更新草稿，不得伪装为已发布');
  assert.equal(editor.listVersions().length, versionsBefore, '导入不得创建发布版本');
  assert.equal(editor.previewBlueprintUpgrade().status, 'current');

  const audit = db.prepare('SELECT actor_id,before_snapshot,after_snapshot FROM control_workflow_blueprint_imports WHERE tenant_id=? AND employee_id=?').get('tenant:jinggong', 'ai:procurement') as { actor_id: string; before_snapshot: string; after_snapshot: string };
  assert.equal(audit.actor_id, 'human:admin');
  assert.equal((JSON.parse(audit.before_snapshot) as Array<{ nodes: Array<{ id: string }> }>).some((workflow) => workflow.nodes.some((node) => node.id === customNode.id)), true);
  assert.equal((JSON.parse(audit.after_snapshot) as Array<{ nodes: Array<{ id: string }> }>).some((workflow) => workflow.nodes.some((node) => node.id === customNode.id)), false);

  const replay = editor.importBlueprint({ expectedRevisions: preview.expectedRevisions, idempotencyKey: 'blueprint-import:test:one', actorId: 'human:admin' });
  assert.equal(replay.status, 'replayed');
  assert.equal(editor.getWorkflow(current.id)!.draftRevision, imported.draftRevision);
  assert.throws(
    () => editor.importBlueprint({ expectedRevisions: { ...preview.expectedRevisions, [current.id]: 999 }, idempotencyKey: 'blueprint-import:test:one', actorId: 'human:admin' }),
    /幂等键已用于不同/,
  );
  db.close();
});

test('Editor: V1 蓝图导入使用全部 expectedRevision，冲突时不部分覆盖', () => {
  const db = new DatabaseSync(':memory:');
  const editor = new EditorStore(db);
  const po = editor.getWorkflow('po-operations')!;
  const driftedPo = editor.saveWorkflow(po.id, { ...po, expectedRevision: po.draftRevision, name: '待迁移的采购订单执行' });
  const preview = editor.previewBlueprintUpgrade();
  const followup = editor.getWorkflow('supplier-followup')!;
  const concurrent = editor.saveWorkflow(followup.id, { ...followup, expectedRevision: followup.draftRevision, name: '另一位用户刚改过的催交流程' });

  assert.throws(
    () => editor.importBlueprint({ expectedRevisions: preview.expectedRevisions, idempotencyKey: 'blueprint-import:test:conflict', actorId: 'human:admin' }),
    /工作流版本冲突/,
  );
  assert.equal(editor.getWorkflow(po.id)!.name, driftedPo.name, '其他流程冲突时不得先覆盖 PO 草稿');
  assert.equal(editor.getWorkflow(followup.id)!.name, concurrent.name);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM control_workflow_blueprint_imports').get() as { count: number }).count, 0);
  db.close();
});

test('Editor: 同一幂等键只创建一条运行记录', () => {
  const db = new DatabaseSync(':memory:');
  const editor = new EditorStore(db);
  const createdAt = new Date().toISOString();
  const base = {
    workflowId: 'po-operations', workflowName: '采购订单执行', mode: 'simulate' as const, status: 'queued' as const,
    sideEffects: 'blocked' as const, decision: {}, message: 'queued', createdAt, idempotencyKey: 'request:stable',
  };
  const first = editor.claimRun({ ...base, id: 'run:one' });
  const second = editor.claimRun({ ...base, id: 'run:two' });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.run.id, 'run:one');
  assert.equal(editor.listRuns().length, 1);
  db.close();
});

test('Editor: 四种模式的运行记录可追溯', () => {
  const db = new DatabaseSync(':memory:');
  const editor = new EditorStore(db);
  const modes = ['simulate', 'shadow', 'supervised', 'autonomous'] as const;
  for (const mode of modes) {
    editor.recordRun({
      id: `run:${mode}`, workflowId: 'po-operations', workflowName: '采购订单执行', mode,
      status: mode === 'supervised' ? 'waiting_approval' : mode === 'autonomous' ? 'ready' : 'completed',
      sideEffects: mode === 'supervised' ? 'approval_gate' : mode === 'autonomous' ? 'enabled' : 'blocked',
      decision: { entry: 'po' }, message: mode, createdAt: new Date().toISOString(),
    });
  }
  assert.deepEqual(new Set(editor.listRuns().map((run) => run.mode)), new Set(modes));
  db.close();
});

test('Editor: 每个 AI 员工拥有独立能力包、工作流、版本、规则和运行记录', () => {
  const db = new DatabaseSync(':memory:');
  const registry = new EditorStoreRegistry(db, ({ employeeId }) => employeeId === 'ai:buyer-one'
    ? ['capability:procurement']
    : ['capability:workforce-core']);
  const procurement = registry.forScope({ tenantId: 't1', employeeId: 'ai:buyer-one' });
  const sales = registry.forScope({ tenantId: 't1', employeeId: 'ai:sales' });

  assert.equal(procurement.getWorkflow('po-operations')?.name, '采购订单执行');
  assert.equal(sales.getWorkflow('procurement-orchestrator'), undefined);
  assert.equal(sales.getWorkflow('employee-task-orchestrator')?.name, '员工任务编排');
  assert.notEqual(procurement.catalog().total, sales.catalog().total);

  sales.recordRun({
    id: 'run:sales', workflowId: 'employee-task-orchestrator', workflowName: '员工任务编排', mode: 'simulate', status: 'completed',
    sideEffects: 'blocked', decision: { entry: 'employee-task' }, message: 'done', createdAt: new Date().toISOString(),
  });
  assert.equal(sales.listRuns().length, 1);
  assert.equal(procurement.listRuns().length, 0);
  assert.equal(registry.forRun('run:sales', { tenantId: 't1', employeeId: 'ai:buyer-one' }).getRun('run:sales')?.employeeId, 'ai:sales');
  db.close();
});

test('Editor: 采购能力包由 capabilityPackIds 决定，不依赖员工 ID 命名', () => {
  const db = new DatabaseSync(':memory:');
  const registry = new EditorStoreRegistry(db, ({ employeeId }) => employeeId === 'ai:arbitrary-name'
    ? ['capability:procurement']
    : ['capability:workforce-core']);

  assert.equal(registry.forScope({ tenantId: 't1', employeeId: 'ai:arbitrary-name' }).getWorkflow('po-operations')?.name, '采购订单执行');
  assert.equal(registry.forScope({ tenantId: 't1', employeeId: 'ai:procurement-looking-name' }).getWorkflow('procurement-orchestrator'), undefined);
  db.close();
});
