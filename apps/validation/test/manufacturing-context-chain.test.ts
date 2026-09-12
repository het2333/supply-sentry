import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const poId = 'po:7c4c2aa5-b119-4e14-8953-a9fc78882e2a';

type AcceptanceOutput = {
  projection: { second: { rootEntityId: string; sourceWatermark: string } };
  snapshot: { id: string; sourceWatermark: string };
  agentEvent: { id: string; inputSnapshotId: string };
};

function runAcceptance(copyPath: string): AcceptanceOutput {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx',
    'apps/validation/src/manufacturing-context-chain.ts',
    copyPath, 't:acme', poId,
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as AcceptanceOutput;
}

test('real acceptance replaces an unrelated stale correlation and reuses the current graph pair', () => {
  const directory = mkdtempSync(join(tmpdir(), 'readywork-context-acceptance-'));
  const copyPath = join(directory, 'acceptance.sqlite');
  const source = new DatabaseSync(join(repoRoot, 'data/readywork.sqlite'));
  try {
    source.exec(`VACUUM INTO '${copyPath.replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }

  const copy = new DatabaseSync(copyPath);
  let legacyEventId = '';
  let legacySnapshotId = '';
  try {
    const event = copy.prepare(`SELECT id,input_snapshot_id FROM twin_agent_events
      WHERE tenant_id='t:acme' AND employee_id='employee:manufacturing-context-validation'
        AND run_id='validation:manufacturing-context:v1'
        AND task_id=? AND event_type='context_read'
      ORDER BY created_at,id LIMIT 1`).get(`validation:real-po:${poId}`) as {
        id: string;
        input_snapshot_id: string;
    } | undefined;
    assert.ok(event, 'real acceptance event must exist in the isolated database snapshot');
    legacyEventId = event.id;
    legacySnapshotId = event.input_snapshot_id;
    copy.exec('DROP TRIGGER trg_twin_agent_events_no_update');
    copy.exec('DROP TRIGGER trg_twin_snapshots_no_update');
    copy.prepare(`UPDATE twin_agent_events SET business_object_id='po:unrelated',entity_id='twin:entity:unrelated'
      WHERE tenant_id='t:acme' AND id=?`).run(event.id);
    copy.prepare(`UPDATE twin_snapshots SET root_entity_id='twin:entity:unrelated',source_watermark='watermark:stale'
      WHERE tenant_id='t:acme' AND id=?`).run(event.input_snapshot_id);
  } finally {
    copy.close();
  }

  try {
    const first = runAcceptance(copyPath);
    const second = runAcceptance(copyPath);
    assert.notEqual(first.snapshot.id, legacySnapshotId, 'stale snapshot was reused');
    assert.notEqual(first.agentEvent.id, legacyEventId, 'unrelated Agent Event was reused');
    assert.equal(first.snapshot.sourceWatermark, first.projection.second.sourceWatermark);
    assert.equal(first.agentEvent.inputSnapshotId, first.snapshot.id);
    assert.deepEqual(second.snapshot, first.snapshot);
    assert.deepEqual(second.agentEvent, first.agentEvent);

    const verified = new DatabaseSync(copyPath, { readOnly: true });
    try {
      const row = verified.prepare(`SELECT business_object_id,entity_id,input_snapshot_id
        FROM twin_agent_events WHERE tenant_id='t:acme' AND id=?`).get(first.agentEvent.id) as {
          business_object_id: string;
          entity_id: string;
          input_snapshot_id: string;
        } | undefined;
      assert.deepEqual({ ...row }, {
        business_object_id: poId,
        entity_id: first.projection.second.rootEntityId,
        input_snapshot_id: first.snapshot.id,
      });
      const snapshot = verified.prepare(`SELECT root_entity_id,source_watermark FROM twin_snapshots
        WHERE tenant_id='t:acme' AND id=?`).get(first.snapshot.id) as {
          root_entity_id: string;
          source_watermark: string;
        } | undefined;
      assert.deepEqual({ ...snapshot }, {
        root_entity_id: first.projection.second.rootEntityId,
        source_watermark: first.projection.second.sourceWatermark,
      });
    } finally {
      verified.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
