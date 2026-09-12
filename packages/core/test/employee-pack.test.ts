import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CORE_WORKFORCE_EMPLOYEE_PACK,
  EmployeePackRegistry,
  validateEmployeePackManifest,
} from '../src/index.js';

test('Employee Pack Registry: 注册、读取和列表返回隔离副本', () => {
  const registry = new EmployeePackRegistry([CORE_WORKFORCE_EMPLOYEE_PACK]);
  const first = registry.get('capability:workforce-core')!;
  first.branding.productName = '被调用方修改';
  first.interfaces.business.navigationGroups[0]!.items[0]!.label = '被修改';

  assert.equal(registry.get('capability:workforce-core')!.branding.productName, 'READYWORK');
  assert.equal(registry.list()[0]!.interfaces.business.navigationGroups[0]!.items[0]!.label, '总览');
  assert.throws(() => registry.register(CORE_WORKFORCE_EMPLOYEE_PACK), /已注册/);
});

test('Employee Pack Registry: 拒绝非法 ID、重复导航和未声明字段', () => {
  const base = structuredClone(CORE_WORKFORCE_EMPLOYEE_PACK) as unknown as Record<string, unknown>;
  assert.throws(() => validateEmployeePackManifest({ ...base, id: 'invalid-pack-id' }), /格式非法/);
  assert.throws(() => validateEmployeePackManifest({ ...base, hiddenCredential: 'secret' }), /未声明字段/);

  const duplicated = structuredClone(CORE_WORKFORCE_EMPLOYEE_PACK);
  duplicated.interfaces.business.navigationGroups[0]!.items.push({ ...duplicated.interfaces.business.navigationGroups[0]!.items[0]! });
  assert.throws(() => validateEmployeePackManifest(duplicated), /重复导航 ID/);

  const undeclared = structuredClone(CORE_WORKFORCE_EMPLOYEE_PACK);
  undeclared.interfaces.business.navigationGroups[0]!.items[0]!.id = 'unknown-page';
  assert.throws(() => validateEmployeePackManifest(undeclared), /未在 ownedSectionIds 中声明/);
});

test('Employee Pack Manifest: 允许无标题导航组但继续拒绝空接口和空入口标签', () => {
  const ungrouped = structuredClone(CORE_WORKFORCE_EMPLOYEE_PACK);
  ungrouped.interfaces.business.navigationGroups[0]!.label = '';
  assert.equal(validateEmployeePackManifest(ungrouped).interfaces.business.navigationGroups[0]!.label, '');

  const emptyInterfaceLabel = structuredClone(ungrouped);
  emptyInterfaceLabel.interfaces.business.label = '';
  assert.throws(() => validateEmployeePackManifest(emptyInterfaceLabel), /label 必须是非空字符串/);

  const emptyItemLabel = structuredClone(ungrouped);
  emptyItemLabel.interfaces.business.navigationGroups[0]!.items[0]!.label = '';
  assert.throws(() => validateEmployeePackManifest(emptyItemLabel), /label 必须是非空字符串/);
});
