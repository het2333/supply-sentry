import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeDomain, surfaceAllows } from '../src/service-surface.js';

test('服务边界: Employee Pack/Editor/Rules/生产监控/内部回调只属于控制面', () => {
  for (const path of ['/api/employee-packs', '/api/employee-packs/capability%3Aprocurement', '/api/editor/workflows', '/api/rules', '/api/operations/readiness', '/api/internal/actions/execute']) {
    assert.equal(routeDomain('GET', path), 'control');
    assert.equal(surfaceAllows('business', 'GET', path), false);
    assert.equal(surfaceAllows('control', 'GET', path), true);
  }
});

test('服务边界: 业务任务不能从控制面访问，员工写操作只能走控制面', () => {
  assert.equal(surfaceAllows('control', 'GET', '/api/tasks'), false);
  assert.equal(surfaceAllows('business', 'GET', '/api/tasks'), true);
  assert.equal(surfaceAllows('business', 'POST', '/api/employees/wizard'), false);
  assert.equal(surfaceAllows('control', 'POST', '/api/employees/wizard'), true);
  assert.equal(surfaceAllows('compat', 'POST', '/api/employees/wizard'), true);
});

test('服务边界: 公开演示重置只属于控制面，状态只属于业务面', () => {
  assert.equal(routeDomain('POST', '/internal/demo/reset'), 'control');
  assert.equal(surfaceAllows('business', 'POST', '/internal/demo/reset'), false);
  assert.equal(surfaceAllows('control', 'POST', '/internal/demo/reset'), true);
  assert.equal(routeDomain('GET', '/api/public-demo/status'), 'business');
  assert.equal(surfaceAllows('business', 'GET', '/api/public-demo/status'), true);
  assert.equal(surfaceAllows('control', 'GET', '/api/public-demo/status'), false);
});
