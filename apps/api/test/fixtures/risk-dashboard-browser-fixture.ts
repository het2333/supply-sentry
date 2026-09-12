import { resolve } from 'node:path';
import type { ProductionProgress, PurchaseOrder, PurchaseOrderLine, Supplier } from '@readywork/core';
import { createProcurementSupplierOperatingProfile, openPersistence } from '@readywork/persistence';

const databasePath = resolve(process.argv[2] ?? 'risk-dashboard-browser.sqlite');
const tenantId = 't:acme';
const at = '2026-09-03T08:00:00.000Z';
const store = openPersistence(databasePath, { tenantId });

const suppliers: Supplier[] = [
  { id: 'supplier:published', tenantId, sourceSystem: 'odoo', externalId: 'SUP-PUBLISHED', status: 'active', createdAt: at, updatedAt: at, name: '华东精密制造', contacts: [], currency: 'CNY', performanceScore: 0 },
  { id: 'supplier:provisional', tenantId, sourceSystem: 'odoo', externalId: 'SUP-PROVISIONAL', status: 'active', createdAt: at, updatedAt: at, name: '远洋工业设备', contacts: [], currency: 'CNY', performanceScore: 50 },
  { id: 'supplier:unpublished', tenantId, sourceSystem: 'odoo', externalId: 'SUP-UNPUBLISHED', status: 'active', createdAt: at, updatedAt: at, name: '待补资料供应商', contacts: [], currency: 'CNY' },
];
for (const supplier of suppliers) store.procurement.saveDocument('supplier', supplier);

for (const [supplierId, productCriticality, route, materialCode, materialName] of [
  ['supplier:published', 'high', 'local', 'VALVE-01', '关键控制阀'],
  ['supplier:unpublished', 'low', 'local', 'SEAL-03', '密封件'],
] as const) {
  createProcurementSupplierOperatingProfile(store.db, tenantId, {
    profile: {
      supplierId, countryCode: 'CN', route, supplierType: 'manufacturer', industry: '工业制造', address: null,
      primaryMaterialCode: materialCode, primaryMaterialName: materialName, defaultLeadTimeDays: 14,
      productCriticality, paymentTerms: 'NET30', contractStartsOn: '2026-01-01', contractEndsOn: '2026-12-31', status: 'active', version: 1,
    },
    actorId: 'h:procurement-manager', reason: 'Risk Dashboard 隔离浏览器验收', source: 'manual', at,
  });
}

const purchaseOrders: Array<PurchaseOrder & { route: 'local' | 'import' }> = [
  { id: 'po:risk:published', tenantId, sourceSystem: 'odoo', externalId: 'P-RISK-001', status: 'sent', createdAt: at, updatedAt: at, supplierId: 'supplier:published', currency: 'CNY', orderedAt: at, route: 'local' },
  { id: 'po:risk:provisional', tenantId, sourceSystem: 'odoo', externalId: 'P-RISK-002', status: 'confirmed', createdAt: at, updatedAt: at, supplierId: 'supplier:provisional', currency: 'CNY', orderedAt: at, route: 'import' },
  { id: 'po:risk:unpublished', tenantId, sourceSystem: 'odoo', externalId: 'P-RISK-003', status: 'confirmed', createdAt: at, updatedAt: at, supplierId: 'supplier:unpublished', currency: 'CNY', orderedAt: at, route: 'local' },
];
for (const purchaseOrder of purchaseOrders) store.procurement.saveDocument('purchase_order', purchaseOrder);

const lines: PurchaseOrderLine[] = [
  { id: 'line:risk:published', poId: 'po:risk:published', lineNumber: '10', itemId: 'VALVE-01', description: '关键控制阀', uom: 'EA', orderedQty: 10, unitPrice: 1200, currency: 'CNY', requestedAt: '2026-08-20T00:00:00.000Z' },
  { id: 'line:risk:provisional', poId: 'po:risk:provisional', lineNumber: '10', itemId: 'PUMP-02', description: '进口离心泵', uom: 'EA', orderedQty: 5, unitPrice: 1200, currency: 'CNY', requestedAt: '2026-08-25T00:00:00.000Z' },
  { id: 'line:risk:unpublished', poId: 'po:risk:unpublished', lineNumber: '10', itemId: 'SEAL-03', description: '密封件', uom: 'EA', orderedQty: 10, unitPrice: 300, currency: 'CNY', requestedAt: '' },
];
for (const line of lines) store.procurement.saveLine('purchase_order_line', line.poId, line);

for (const [id, poId, supplierId, status] of [
  ['production-progress:risk:published', 'po:risk:published', 'supplier:published', 'blocked'],
  ['production-progress:risk:provisional', 'po:risk:provisional', 'supplier:provisional', 'delayed'],
] as const) {
  const progress: ProductionProgress = {
    id, tenantId, sourceSystem: 'readywork-manual-verification', externalId: id.toUpperCase(), status: 'recorded',
    createdAt: at, updatedAt: at, poId, supplierId, reportedAt: at, overallStatus: status,
    evidenceSource: 'manual_verified', evidenceReference: `browser-fixture:${id}`,
    verifiedBy: 'h:procurement-manager', verificationReason: '隔离验收事实',
  };
  store.procurement.saveDocument('production_progress', progress);
}

const legacy = {
  id: 'risk:legacy:browser', sourceWatermark: 'legacy-browser-watermark', asOf: '2026-08-05T08:00:00.000Z',
  metrics: { total: 1, high: 1, medium: 0, low: 0, highRiskPercent: 100, atRiskValueByCurrency: { CNY: 12000 }, averageRiskScore: 88 },
  riskDistribution: [{ risk: 'high', count: 1 }, { risk: 'medium', count: 0 }, { risk: 'low', count: 0 }],
  riskBreakdown: [], suppliers: [], aging: [], products: [], items: [],
};
store.db.prepare(`INSERT INTO procurement_risk_snapshots
  (tenant_id,id,source_watermark,as_of,snapshot_json,created_by,created_at) VALUES (?,?,?,?,?,?,?)`)
  .run(tenantId, legacy.id, legacy.sourceWatermark, legacy.asOf, JSON.stringify(legacy), 'browser-fixture', legacy.asOf);

console.log(JSON.stringify({ databasePath, tenantId, purchaseOrders: purchaseOrders.length, legacySnapshots: 1 }));
store.close();
