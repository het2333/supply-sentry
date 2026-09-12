/**
 * 采购路径编排器演示 —— 一个「采购执行员工」按业务情况动态路由，
 * 只调用需要的工作流，跳过不需要的步骤（采购网络，而非固定流水线）。
 *
 * 用法：pnpm demo:orchestrator
 */
import { ProcurementOrchestrator } from '@readywork/supply-chain';
import type { PurchasePathInput } from '@readywork/supply-chain';

const o = new ProcurementOrchestrator();

const cases: { name: string; input: PurchasePathInput }[] = [
  { name: 'A. 已有 PO（最常见：接已有 ERP）', input: { kind: 'po', poName: 'P00011', hasPo: true } },
  { name: 'B. 框架合同价有效 → 直接 PO', input: { kind: 'requisition', hasContractPrice: true, contractPriceValid: true, hasQualifiedSupplier: true } },
  { name: 'C. 无合同价 → 询价比价', input: { kind: 'requisition', hasContractPrice: false, hasQualifiedSupplier: true } },
  { name: 'D. 无合格供应商 → 寻源', input: { kind: 'requisition', hasQualifiedSupplier: false } },
  { name: 'E. 已收货 + 发票 → 三单匹配', input: { kind: 'invoice', hasInvoice: true, hasPo: true, hasReceipt: true } },
  { name: 'F. 发票先到、货未到 → 等待收货', input: { kind: 'invoice', hasInvoice: true, hasPo: true, hasReceipt: false } },
  { name: 'G. 无 PO 发票 → 异常', input: { kind: 'invoice', hasInvoice: true, hasPo: false, hasReceipt: false } },
  { name: 'H. 紧急采购（已有 PO）→ 高频催交', input: { kind: 'po', poName: 'P00019', hasPo: true, urgent: true } },
];

console.log('═'.repeat(72));
console.log('  采购执行员工 · 采购路径编排器（动态路由，非固定流水线）');
console.log('═'.repeat(72));
for (const c of cases) {
  const d = o.decide(c.input);
  console.log(`\n  ${c.name}`);
  console.log(`    入口     : ${d.entry}`);
  console.log(`    执行工作流: ${d.workflows.length ? d.workflows.join(' → ') : '（无，等待/异常）'}`);
  console.log(`    跳过     : ${d.skipped.length ? d.skipped.join('、') : '无'}`);
  console.log(`    理由     : ${d.reason}`);
}
console.log('\n' + '═'.repeat(72));
console.log('  结论：一个员工理解「当前业务走到哪一步」，自动选择下一步该做什么。');
