import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import {
  PUBLIC_DEMO_IDS,
  PUBLIC_DEMO_SEED_VERSION,
  readPublicDemoStatus,
  resetPublicDemo,
} from '../src/public-demo-reset.js';

function addForeignTenantSentinel(db: ReturnType<typeof openPersistence>['db']): void {
  const now = '2026-09-13T03:00:00.000Z';
  db.prepare(`INSERT INTO procurement_notifications
    (tenant_id,id,fingerprint,type,severity,title,message,tag,object_type,object_id,evidence_json,status,version,created_at,updated_at)
    VALUES ('t:acme','notification:foreign','foreign','system','info','keep','keep','system',NULL,NULL,'{}','unread',1,?,?)`
  ).run(now, now);
}

test('public demo reset seeds a coherent eight-scenario tenant and preserves every foreign tenant', () => {
  const store = openPersistence(':memory:', { tenantId: 't:public-demo' });
  try {
    addForeignTenantSentinel(store.db);
    const result = resetPublicDemo(store.db, new Date('2026-09-13T04:00:00.000Z'));
    assert.deepEqual(result, {
      ok: true,
      tenantId: 't:public-demo',
      seedVersion: PUBLIC_DEMO_SEED_VERSION,
      generation: 1,
      resetAt: '2026-09-13T04:00:00.000Z',
      scenarioCount: 8,
    });

    const scenarios = store.db.prepare(`SELECT id FROM public_demo_scenarios
      WHERE tenant_id='t:public-demo' ORDER BY id`).all() as Array<{ id: string }>;
    assert.equal(scenarios.length, 8);
    assert.deepEqual(new Set(scenarios.map((row) => row.id)), new Set(Object.values(PUBLIC_DEMO_IDS)));
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_documents
      WHERE tenant_id='t:public-demo' AND kind='purchase_order'`).get() as { count: number }).count, 5);
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_execution_approvals
      WHERE tenant_id='t:public-demo' AND status='pending'`).get() as { count: number }).count, 1);
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_outbox
      WHERE tenant_id='t:public-demo'`).get() as { count: number }).count, 2);
    assert.equal((store.db.prepare(`SELECT COUNT(*) AS count FROM procurement_notifications
      WHERE tenant_id='t:public-demo'`).get() as { count: number }).count >= 1, true);
    assert.ok(store.db.prepare(`SELECT 1 FROM procurement_notifications
      WHERE tenant_id='t:acme' AND id='notification:foreign'`).get());

    const serialized = JSON.stringify(store.db.prepare(`SELECT json FROM procurement_documents
      WHERE tenant_id='t:public-demo'`).all());
    assert.doesNotMatch(serialized, /@(qq|163|126)\.com|@[\w.-]+\.cn/i);
    assert.match(serialized, /@example\.(?:com|test)/i);
    const attachment = store.db.prepare(`SELECT content,sha256 FROM procurement_attachments
      WHERE tenant_id='t:public-demo' AND id='attachment:public-demo:packing-list'`).get() as { content: Uint8Array; sha256: string };
    assert.equal(createHash('sha256').update(attachment.content).digest('hex'), attachment.sha256);
  } finally {
    store.close();
  }
});

test('public demo reset increments generation and restores a mutated purchase order', () => {
  const store = openPersistence(':memory:', { tenantId: 't:public-demo' });
  try {
    resetPublicDemo(store.db, new Date('2026-09-13T04:00:00.000Z'));
    store.db.prepare(`UPDATE procurement_documents SET status='received',json=json_set(json,'$.status','received')
      WHERE tenant_id='t:public-demo' AND kind='purchase_order' AND id=?`).run(PUBLIC_DEMO_IDS.partialShipmentPo);
    const result = resetPublicDemo(store.db, new Date('2026-09-13T05:00:00.000Z'));
    assert.equal(result.generation, 2);
    const restored = store.db.prepare(`SELECT status FROM procurement_documents
      WHERE tenant_id='t:public-demo' AND kind='purchase_order' AND id=?`).get(PUBLIC_DEMO_IDS.partialShipmentPo) as { status: string };
    assert.equal(restored.status, 'partially_shipped');
    assert.deepEqual(readPublicDemoStatus(store.db), {
      demoMode: true,
      tenantId: 't:public-demo',
      seedVersion: PUBLIC_DEMO_SEED_VERSION,
      generation: 2,
      resetAt: '2026-09-13T05:00:00.000Z',
      status: 'healthy',
    });
  } finally {
    store.close();
  }
});

test('public demo seed failure rolls back all deletion and marks health degraded', () => {
  const store = openPersistence(':memory:', { tenantId: 't:public-demo' });
  try {
    resetPublicDemo(store.db, new Date('2026-09-13T04:00:00.000Z'));
    const before = store.db.prepare(`SELECT kind,id,status,json FROM procurement_documents
      WHERE tenant_id='t:public-demo' ORDER BY kind,id`).all();
    store.db.exec(`CREATE TRIGGER fail_public_demo_seed
      BEFORE INSERT ON procurement_documents
      WHEN NEW.tenant_id='t:public-demo' AND NEW.id='purchase-order:public-demo:normal'
      BEGIN SELECT RAISE(ABORT, 'forced seed failure'); END`);

    assert.throws(
      () => resetPublicDemo(store.db, new Date('2026-09-13T05:00:00.000Z')),
      /forced seed failure/,
    );
    const after = store.db.prepare(`SELECT kind,id,status,json FROM procurement_documents
      WHERE tenant_id='t:public-demo' ORDER BY kind,id`).all();
    assert.deepEqual(after, before);
    const status = readPublicDemoStatus(store.db);
    assert.equal(status.generation, 1);
    assert.equal(status.status, 'degraded');
  } finally {
    store.close();
  }
});
