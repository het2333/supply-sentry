import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const composeUrl = new URL('../compose.preview.yml', import.meta.url);
const composePath = decodeURIComponent(composeUrl.pathname);
const requiredSecrets = [
  'READYWORK_SESSION_SECRET',
  'READYWORK_CREDENTIAL_KEY',
  'READYWORK_INTERNAL_CALLBACK_TOKEN',
  'READYWORK_INTERNAL_TOKEN',
  'READYWORK_COLLABORATION_SIGNING_SECRET',
  'READYWORK_TEMPORAL_DB_PASSWORD',
  'READYWORK_HERMES_BRIDGE_SECRET',
  'HERMES_DASHBOARD_SESSION_TOKEN',
  'DEEPSEEK_API_KEY',
];

const testEnvironment = Object.fromEntries(requiredSecrets.map((name, index) => [name, `contract-only-${index}-${'x'.repeat(32)}`]));

test('preview topology publishes only the console on the approved public address', async () => {
  const source = await readFile(composeUrl, 'utf8');
  for (const name of requiredSecrets) {
    assert.match(source, new RegExp(`\\$\\{${name}:\\?`), `${name} must be required`);
  }
  assert.doesNotMatch(source, /READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH/);

  const rendered = spawnSync('docker', ['compose', '-f', composePath, 'config', '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, ...testEnvironment },
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const config = JSON.parse(rendered.stdout);
  const services = config.services;
  for (const serviceName of ['console', 'business-api', 'control-api', 'temporal-worker', 'temporal', 'temporal-db', 'gateway', 'dashboard']) {
    assert.ok(services[serviceName], `${serviceName} is missing`);
    assert.equal(services[serviceName].restart, 'unless-stopped', `${serviceName} must restart after reboot`);
  }

  assert.deepEqual(services.console.ports, [{
    mode: 'ingress',
    target: 3001,
    published: '3001',
    protocol: 'tcp',
  }]);
  assert.match(services['business-api'].environment.READYWORK_ALLOWED_ORIGINS, /http:\/\/47\.102\.116\.148:3001(?:,|$)/);

  for (const [serviceName, service] of Object.entries(services)) {
    if (serviceName === 'console') continue;
    for (const port of service.ports ?? []) {
      assert.equal(port.host_ip, '127.0.0.1', `${serviceName} publishes a non-loopback port`);
    }
  }

  for (const serviceName of ['business-api', 'control-api', 'temporal-worker']) {
    const mounts = services[serviceName].volumes ?? [];
    assert.ok(mounts.some((mount) => mount.source === '/opt/readywork/shared/data' && mount.target === '/app/data'), `${serviceName} does not share business data`);
    assert.equal(services[serviceName].command[0], 'node', `${serviceName} must not invoke a package manager at runtime`);
    assert.ok(services[serviceName].command.includes('--import'), `${serviceName} must load TypeScript through Node`);
  }
  assert.equal(services.console.command[0], 'node', 'console must not invoke a package manager at runtime');
  assert.equal(services.console.working_dir, '/app/apps/console', 'console must start from the directory containing its production build');
  for (const serviceName of ['gateway', 'dashboard']) {
    const mounts = services[serviceName].volumes ?? [];
    assert.ok(mounts.some((mount) => mount.source === '/opt/readywork/shared/hermes' && mount.target === '/opt/data'), `${serviceName} does not share Hermes data`);
  }
});

test('production worker receives the pinned DeepSeek Harness runtime instead of a test stub', () => {
  const rendered = spawnSync('docker', ['compose', '-f', composePath, 'config', '--format', 'json'], {
    encoding: 'utf8',
    env: { ...process.env, ...testEnvironment },
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  const worker = JSON.parse(rendered.stdout).services['temporal-worker'];

  assert.equal(worker.environment.READYWORK_AGENT_RUNTIME, 'dsh');
  assert.equal(worker.environment.READYWORK_DSH_REPO, '/opt/readywork/runtime/deepseek-harness');
  assert.equal(worker.environment.READYWORK_DSH_COMMAND, '/opt/readywork/runtime/deepseek-harness/.runtime/node');
  assert.equal(worker.environment.DEEPSEEK_API_KEY, testEnvironment.DEEPSEEK_API_KEY);
  assert.ok(worker.volumes.some((mount) => (
    mount.source === '/opt/readywork/shared/runtime/deepseek-harness'
      && mount.target === '/opt/readywork/runtime/deepseek-harness'
      && mount.read_only === true
  )), 'temporal-worker does not mount the pinned DeepSeek Harness checkout read-only');
});
