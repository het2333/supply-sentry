import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PolicyEngine, matchPattern } from '@readywork/core';
import type { PermissionRule, PolicyRule } from '@readywork/core';

const engine = new PolicyEngine();

test('Policy: 默认拒绝（无 allow 即拒绝）', () => {
  assert.equal(engine.can([], 'po.get', 'erp'), false);
});

test('Policy: 显式 allow 放行，deny 优先', () => {
  const rules: PermissionRule[] = [
    { effect: 'allow', action: 'po.update', resource: 'erp' },
    { effect: 'deny', action: 'po.updatePrice', resource: 'erp' },
  ];
  assert.equal(engine.can(rules, 'po.update', 'erp'), true);
  assert.equal(engine.can(rules, 'po.updatePrice', 'erp'), false);
});

test('Policy: 通配符 前缀.* 与 *', () => {
  assert.equal(matchPattern('po.*', 'po.get'), true);
  assert.equal(matchPattern('po.*', 'po.update'), true);
  assert.equal(matchPattern('po.*', 'rfq.get'), false);
  assert.equal(matchPattern('*', 'anything'), true);
});

test('Policy: 策略求值（block / require_approval）', () => {
  const rules: PolicyRule[] = [
    {
      id: 'pol-price-lock',
      name: '价格锁定',
      when: (ctx) => ctx.action === 'po.updatePrice',
      then: 'block',
      message: '不可修改价格',
    },
  ];
  const hit = engine.evaluatePolicies(rules, { employeeId: 'e1', action: 'po.updatePrice', resource: 'erp', now: new Date() });
  assert.equal(hit.length, 1);
  assert.equal(hit[0]!.then, 'block');
  const miss = engine.evaluatePolicies(rules, { employeeId: 'e1', action: 'po.get', resource: 'erp', now: new Date() });
  assert.equal(miss.length, 0);
});
