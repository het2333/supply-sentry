import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PUBLIC_DEMO_TENANT_ID,
  assertPublicDemoConfiguration,
  publicDemoCapabilities,
  publicDemoCapabilityDenied,
  publicDemoMode,
} from '../src/public-demo-mode.js';
import { can, createPublicDemoSession, resolveSession } from '../src/auth.js';

function withEnvironment(values: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('public demo mode accepts only the exact dedicated environment switch', () => {
  withEnvironment({ READYWORK_PUBLIC_DEMO: '1' }, () => assert.equal(publicDemoMode(), true));
  for (const value of [undefined, '', '0', 'true', 'yes']) {
    withEnvironment({ READYWORK_PUBLIC_DEMO: value }, () => assert.equal(publicDemoMode(), false));
  }
});

test('public demo denies administration, credentials, callbacks, uploads, and file egress', () => {
  const denied: Array<[string, string]> = [
    ['GET', '/api/editor/workflows'],
    ['GET', '/api/operations/readiness'],
    ['POST', '/api/connectors/webhook/t%3Apublic-demo/credential'],
    ['PUT', '/api/messaging/platforms/weixin'],
    ['POST', '/api/messaging/onboarding/weixin'],
    ['POST', '/api/procurement/import-documents/pos/po%3A1/documents'],
    ['POST', '/api/procurement/routes/local/exports'],
    ['GET', '/api/procurement/route-exports/export%3A1/download'],
  ];
  for (const [method, path] of denied) assert.equal(publicDemoCapabilityDenied(method, path), true, `${method} ${path}`);
  assert.equal(publicDemoCapabilityDenied('GET', '/api/procurement/workbench'), false);
  assert.equal(publicDemoCapabilityDenied('POST', '/api/tasks/task%3A1/approve'), false);
});

test('public demo configuration fails closed without its fixed tenant and simulation policy', () => {
  withEnvironment({
    READYWORK_PUBLIC_DEMO: '1',
    READYWORK_PUBLIC_DEMO_TENANT: PUBLIC_DEMO_TENANT_ID,
    READYWORK_PUBLIC_DEMO_SIMULATION_POLICY: undefined,
  }, () => assert.throws(assertPublicDemoConfiguration, /simulation policy/i));

  withEnvironment({
    READYWORK_PUBLIC_DEMO: '1',
    READYWORK_PUBLIC_DEMO_TENANT: 't:acme',
    READYWORK_PUBLIC_DEMO_SIMULATION_POLICY: 'simulated_demo',
  }, () => assert.throws(assertPublicDemoConfiguration, /tenant configuration/i));
});

test('public demo capabilities expose a fixed non-egress tenant contract', () => {
  withEnvironment({
    READYWORK_PUBLIC_DEMO: '1',
    READYWORK_PUBLIC_DEMO_TENANT: PUBLIC_DEMO_TENANT_ID,
    READYWORK_PUBLIC_DEMO_SIMULATION_POLICY: 'simulated_demo',
  }, () => {
    assert.doesNotThrow(assertPublicDemoConfiguration);
    assert.deepEqual(publicDemoCapabilities(), {
      demoMode: true,
      tenantId: 't:public-demo',
      syntheticData: true,
      externalDelivery: false,
      uploads: false,
      credentialManagement: false,
    });
  });
});

test('public demo session is signed, fixed to its tenant, and cannot administer the platform', () => {
  withEnvironment({
    READYWORK_PUBLIC_DEMO: '1',
    READYWORK_PUBLIC_DEMO_TENANT: PUBLIC_DEMO_TENANT_ID,
    READYWORK_PUBLIC_DEMO_SIMULATION_POLICY: 'simulated_demo',
  }, () => {
    const result = createPublicDemoSession(1_800_000_000_000);
    assert.deepEqual(result.session, {
      username: 'public-demo',
      tenantId: 't:public-demo',
      humanId: 'h:public-demo-manager',
      name: '公开演示采购经理',
      role: '采购经理',
      expiresAt: 1_800_043_200_000,
    });
    assert.deepEqual(resolveSession(result.token), result.session);
    assert.equal(can(result.session, 'read'), true);
    assert.equal(can(result.session, 'operate'), true);
    assert.equal(can(result.session, 'approve'), true);
    assert.equal(can(result.session, 'configure'), true);
    assert.equal(can(result.session, 'admin'), false);
  });
});
