import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createProcurementRouteExport,
  findProcurementRouteExportByIdempotency,
  getProcurementRouteExport,
  openPersistence,
} from '@readywork/persistence';

test('route export repository keeps metadata tenant-scoped and enforces one idempotency record', () => {
  const store = openPersistence(':memory:', { tenantId: 'tenant:route-export' });
  try {
    const inserted = createProcurementRouteExport(store.db, {
      tenantId: store.tenantId,
      id: 'route-export:one',
      route: 'local',
      normalizedFiltersJson: '{"query":"bolt"}',
      sourceWatermark: 'portfolio:2026-09-02T00:00:00.000Z',
      rowCount: 2,
      contentSha256: 'a'.repeat(64),
      sizeBytes: 234,
      objectKey: 'tenants/scoped/object',
      state: 'ready',
      createdBy: 'human:buyer',
      createdAt: '2026-09-02T01:00:00.000Z',
      expiresAt: '2026-09-03T01:00:00.000Z',
      idempotencyKey: 'route-export:key',
    });
    assert.equal(inserted.id, 'route-export:one');
    assert.equal(getProcurementRouteExport(store.db, store.tenantId, inserted.id)?.rowCount, 2);
    assert.equal(getProcurementRouteExport(store.db, 'tenant:other', inserted.id), null);
    assert.equal(findProcurementRouteExportByIdempotency(store.db, store.tenantId, 'route-export:key')?.contentSha256, 'a'.repeat(64));
    assert.equal(findProcurementRouteExportByIdempotency(store.db, 'tenant:other', 'route-export:key'), null);
    assert.throws(() => createProcurementRouteExport(store.db, { ...inserted, id: 'route-export:two' }), /UNIQUE constraint failed/u);
    assert.equal(store.db.prepare('PRAGMA table_info(procurement_route_exports)').all().some((column: unknown) => (column as { name: string }).name === 'content'), false);
  } finally { store.close(); }
});
