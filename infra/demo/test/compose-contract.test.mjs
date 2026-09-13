import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const composeUrl = new URL('../compose.yml', import.meta.url);
const composePath = decodeURIComponent(composeUrl.pathname);
const contractEnvironment = {
  ...process.env,
  READYWORK_SESSION_SECRET: 'contract-session-secret-0123456789abcdef',
  READYWORK_INTERNAL_CALLBACK_TOKEN: 'contract-callback-token-0123456789abcdef',
  READYWORK_INTERNAL_TOKEN: 'contract-internal-token-0123456789abcdef',
  READYWORK_TEMPORAL_DB_PASSWORD: 'contract-temporal-password',
};

test('public demo topology has exactly eight isolated services and publishes only the console', async () => {
  const source = await readFile(composeUrl, 'utf8');
  assert.doesNotMatch(source, /\/opt\/readywork\/shared/u);

  const rendered = spawnSync('docker', ['compose', '-f', composePath, 'config', '--format', 'json'], {
    encoding: 'utf8', env: contractEnvironment,
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const config = JSON.parse(rendered.stdout);
  assert.deepEqual(Object.keys(config.services).sort(), [
    'business-api', 'console', 'control-api', 'mock-model', 'reset-worker', 'temporal', 'temporal-db', 'temporal-worker',
  ]);

  for (const [name, service] of Object.entries(config.services)) {
    if (name === 'console') {
      assert.deepEqual(service.ports, [{ mode: 'ingress', host_ip: '127.0.0.1', target: 3001, published: '3002', protocol: 'tcp' }]);
    } else {
      assert.deepEqual(service.ports ?? [], [], `${name} must not publish a host port`);
    }
    for (const mount of service.volumes ?? []) {
      assert.notEqual(mount.type, 'bind', `${name} must not use host bind mounts`);
      assert.doesNotMatch(String(mount.source), /readywork_shared|readywork\/shared/u);
    }
  }

  for (const name of ['business-api', 'control-api', 'temporal-worker', 'console', 'mock-model', 'reset-worker']) {
    const environment = config.services[name].environment;
    assert.equal(environment.READYWORK_PUBLIC_DEMO, '1', `${name} is not in public-demo mode`);
    assert.equal(environment.READYWORK_PUBLIC_DEMO_TENANT, 't:public-demo');
    assert.equal(environment.READYWORK_PUBLIC_DEMO_SIMULATION_POLICY, 'simulated_demo');
    for (const key of Object.keys(environment)) {
      assert.doesNotMatch(key, /HERMES|ODOO|ERP|DEEPSEEK/u, `${name} exposes forbidden integration environment ${key}`);
    }
  }

  assert.equal(config.services['business-api'].environment.READYWORK_MODEL_BASE_URL, 'http://mock-model:18080');
  assert.equal(config.services['reset-worker'].environment.READYWORK_DEMO_API_URL, 'http://control-api:4174');
  assert.deepEqual(
    config.services.temporal.healthcheck.test,
    ['CMD', 'temporal', 'operator', 'cluster', 'health', '--address', 'temporal:7233'],
    'Temporal listens on its container interface, so its healthcheck must not target loopback',
  );
  assert.equal(config.volumes.demo_data.name, 'supplysentry_demo_data');
  assert.equal(config.volumes.temporal_data.name, 'supplysentry_demo_temporal_data');
});

test('build overlay targets the local demo image without changing isolation', () => {
  const overlayPath = decodeURIComponent(new URL('../compose.build.yml', import.meta.url).pathname);
  const rendered = spawnSync('docker', ['compose', '-f', composePath, '-f', overlayPath, 'config', '--format', 'json'], {
    encoding: 'utf8', env: { ...contractEnvironment, READYWORK_DEMO_IMAGE: 'readywork-demo:contract' },
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const config = JSON.parse(rendered.stdout);
  for (const name of ['business-api', 'control-api', 'temporal-worker', 'console', 'mock-model', 'reset-worker']) {
    assert.equal(config.services[name].image, 'readywork-demo:contract');
    assert.equal(config.services[name].build.target, 'readywork-demo');
  }
});
