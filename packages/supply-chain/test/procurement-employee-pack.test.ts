import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROCUREMENT_BUSINESS_NAVIGATION,
  PROCUREMENT_EMPLOYEE_PACK,
  PROCUREMENT_NODE_DESCRIPTORS,
  SUPPLY_CHAIN_SPECS,
} from '../src/index.js';

test('Procurement Employee Pack: 清单绑定真实采购资产且不包含凭据或业务记录', () => {
  const manifest = PROCUREMENT_EMPLOYEE_PACK;
  const spec = SUPPLY_CHAIN_SPECS.find((item) => item.id === 'spec:procurement')!;
  assert.deepEqual(spec.capabilityPackIds, [manifest.id]);
  assert.equal(manifest.version, spec.version);
  assert.equal(manifest.assets.employeeSpecIds.includes(spec.id), true);

  for (const workerId of spec.workers) assert.equal(manifest.assets.workerIds.includes(workerId), true, `缺少 Worker ${workerId}`);
  for (const workflowId of spec.workflows) assert.equal(manifest.assets.workflowIds.includes(workflowId), true, `缺少 Workflow ${workflowId}`);
  for (const skillId of spec.skills) assert.equal(manifest.assets.skillIds.includes(skillId), true, `缺少 Skill ${skillId}`);
  const registeredNodeTypes = new Set(PROCUREMENT_NODE_DESCRIPTORS.map((item) => item.type));
  for (const nodeTypeId of manifest.assets.nodeTypeIds) assert.equal(registeredNodeTypes.has(nodeTypeId), true, `未知节点类型 ${nodeTypeId}`);

  assert.equal(manifest.version, '1.0.0');
  assert.match(manifest.description, /PO.*GRN/);
  for (const excluded of ['requisition-classifier', 'rfq-collect', 'rfq-recommend', 'invoice-parser', 'threeway-match', 'procurement-intake']) {
    assert.equal(manifest.assets.workerIds.includes(excluded), false, `${excluded} 不属于 post-PO V1`);
  }
  for (const excluded of ['requisition-confirm', 'rfq-process', 'invoice-match']) {
    assert.equal(manifest.assets.workflowIds.includes(excluded), false, `${excluded} 不属于 post-PO V1`);
  }
  assert.equal(manifest.connectors.find((item) => item.connectorId === 'email')?.required, true);
  assert.equal(manifest.connectors.find((item) => item.connectorId === 'erp')?.required, false);
  assert.equal(manifest.lifecycle?.entityType, 'purchase_order');
  assert.equal(manifest.lifecycle?.startStageId, 'po-sent');
  assert.equal(manifest.lifecycle?.terminalStageId, 'grn');
  assert.deepEqual(manifest.lifecycle?.stages.map((stage) => stage.label), [
    'PO 已发送', '供应商承诺', '生产', '发运 / 运输', 'GRN',
  ]);
  for (const stage of manifest.lifecycle?.stages ?? []) {
    for (const workflowId of stage.workflowIds) assert.equal(manifest.assets.workflowIds.includes(workflowId), true);
  }

  const serialized = JSON.stringify(manifest).toLowerCase();
  for (const forbidden of ['authorizationcode', 'apikey', 'password', 'businessobject', 'purchase-order:odoo']) {
    assert.equal(serialized.includes(forbidden), false, `Manifest 不应包含 ${forbidden}`);
  }
});

test('Procurement Employee Pack: Readywork 品牌和十项业务入口由单一清单声明', () => {
  const business = PROCUREMENT_EMPLOYEE_PACK.interfaces.business;
  const expected = [
    ['home', '总览'],
    ['notifications', '通知'],
    ['message-drafts', '邮件草稿'],
    ['local-procurement', '本地采购'],
    ['import-procurement', '进口采购'],
    ['risk-dashboard', '风险看板'],
    ['suppliers', '供应商'],
    ['sla', '服务等级'],
    ['advanced-sla', '高级服务等级'],
    ['settings', '自动跟单'],
  ];
  const items = business.navigationGroups.flatMap((group) => group.items);
  assert.deepEqual(items.map(({ id, label }) => [id, label]), expected);
  assert.deepEqual(PROCUREMENT_BUSINESS_NAVIGATION.map(({ id, label }) => [id, label]), expected);
  assert.equal(PROCUREMENT_EMPLOYEE_PACK.name, 'Readywork 采购执行');
  assert.equal(PROCUREMENT_EMPLOYEE_PACK.branding.themeId, 'readywork-procurement');
  assert.deepEqual(business.navigationGroups.map(({ label }) => label), ['']);
  assert.equal(business.ownedSectionIds.includes('orders'), true, 'PO 详情必须保留为受控深链入口');
  assert.equal(business.ownedSectionIds.includes('po-intake'), true, 'PO intake 必须保留为受控深链入口');
  for (const hidden of ['orders', 'po-intake', 'employees']) {
    assert.equal(items.some((item) => item.id === hidden), false, `${hidden} 不能进入业务一级导航`);
  }
  for (const excluded of ['requisitions', 'sourcing', 'payables', 'logistics', 'documents', 'ai-records']) {
    assert.equal(business.ownedSectionIds.includes(excluded), false, `${excluded} 不属于 Readywork Procurement Execution 页面范围`);
  }
  assert.equal(PROCUREMENT_EMPLOYEE_PACK.interfaces.developer.enabled, true);
  assert.equal(PROCUREMENT_EMPLOYEE_PACK.interfaces.developer.defaultSectionId, 'employees');
  assert.deepEqual(PROCUREMENT_EMPLOYEE_PACK.interfaces.developer.ownedSectionIds, ['employees']);
});
