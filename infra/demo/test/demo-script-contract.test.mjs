import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const repoRoot = resolve(decodeURIComponent(new URL('../../..', import.meta.url).pathname));
const script = join(repoRoot, 'scripts/demo/demo.sh');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'supplysentry-demo-script-'));
  const bin = join(root, 'bin');
  const log = join(root, 'commands.log');
  const envFile = join(root, 'demo.env');
  mkdirSync(bin, { recursive: true });
  writeFileSync(envFile, [
    'READYWORK_SESSION_SECRET=test-session-secret',
    'READYWORK_INTERNAL_CALLBACK_TOKEN=test-callback-token',
    'READYWORK_INTERNAL_TOKEN=test-internal-token',
    'READYWORK_TEMPORAL_DB_PASSWORD=test-temporal-password',
  ].join('\n'));
  const executable = (name, body) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  executable('docker', 'printf "docker %s\\n" "$*" >> "$DEMO_TEST_LOG"; exit 0');
  executable('curl', 'printf "curl %s\\n" "$*" >> "$DEMO_TEST_LOG"; printf \'{"ok":true,"generation":2}\\n\'; exit 0');
  executable('node', 'printf "node callback=%s %s\\n" "${READYWORK_INTERNAL_CALLBACK_TOKEN:+SET}" "$*" >> "$DEMO_TEST_LOG"; exit 0');
  return {
    root, log, envFile,
    run(args, input = '') {
      return spawnSync('sh', [script, ...args], {
        cwd: repoRoot, encoding: 'utf8', input,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DEMO_TEST_LOG: log, READYWORK_DEMO_ENV_FILE: envFile },
      });
    },
    commands: () => existsSync(log) ? readFileSync(log, 'utf8') : '',
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('up --build uses the isolated project, waits for health, and verifies port 3002', () => {
  const f = fixture();
  try {
    const result = f.run(['up', '--build']);
    assert.equal(result.status, 0, result.stderr);
    const commands = f.commands();
    assert.match(commands, /docker compose .*--project-name supplysentry-demo.*compose\.yml.*compose\.build\.yml.*up -d --build --wait/u);
    assert.match(commands, /curl .*http:\/\/127\.0\.0\.1:3002\//u);
    assert.match(result.stdout, /\.\/scripts\/demo\/demo\.sh logs/u);
    assert.match(result.stdout, /\.\/scripts\/demo\/demo\.sh down/u);
  } finally { f.close(); }
});

test('reset authenticates internally while down preserves volumes', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['reset']).status, 0);
    assert.match(f.commands(), /docker compose .* exec -T control-api node -e .*http:\/\/127\.0\.0\.1:4174\/internal\/demo\/reset/u);
    assert.match(f.commands(), /x-readywork-internal-token.*READYWORK_INTERNAL_CALLBACK_TOKEN/u);
    assert.equal(f.run(['down']).status, 0);
    assert.match(f.commands(), /docker compose .* down$/mu);
    assert.doesNotMatch(f.commands(), /down --volumes/u);
  } finally { f.close(); }
});

test('status and verify inspect the isolated stack without exposing the internal token', () => {
  const f = fixture();
  try {
    assert.equal(f.run(['status']).status, 0);
    assert.match(f.commands(), /docker compose .*--project-name supplysentry-demo .* ps$/mu);

    assert.equal(f.run(['verify']).status, 0);
    assert.match(f.commands(), /node callback=SET .*scripts\/demo\/verify-public-demo\.mjs http:\/\/127\.0\.0\.1:3002\//u);
    assert.doesNotMatch(f.commands(), /test-callback-token/u);
  } finally { f.close(); }
});

test('purge requires the exact interactive confirmation before deleting volumes', () => {
  const denied = fixture();
  try {
    assert.notEqual(denied.run(['purge'], 'wrong\n').status, 0);
    assert.doesNotMatch(denied.commands(), /down --volumes/u);
  } finally { denied.close(); }

  const approved = fixture();
  try {
    assert.equal(approved.run(['purge'], 'purge\n').status, 0);
    assert.match(approved.commands(), /down --volumes/u);
  } finally { approved.close(); }
});
