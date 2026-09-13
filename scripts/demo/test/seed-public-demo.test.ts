import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../../..');

test('public demo seed CLI writes and verifies one isolated deterministic generation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'supplysentry-public-demo-seed-'));
  const databasePath = join(directory, 'demo.sqlite');
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/demo/seed-public-demo.ts', '--reset-at', '2026-09-13T04:00:00.000Z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        DB_PATH: databasePath,
        READYWORK_PUBLIC_DEMO: '1',
        READYWORK_PUBLIC_DEMO_TENANT: 't:public-demo',
        READYWORK_PUBLIC_DEMO_SIMULATION_POLICY: 'simulated_demo',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      tenantId: 't:public-demo',
      seedVersion: 'public-demo-v1',
      generation: 1,
      resetAt: '2026-09-13T04:00:00.000Z',
      scenarioCount: 8,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
