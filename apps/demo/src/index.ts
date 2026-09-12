import { createSupplyChainRuntime } from '@readywork/supply-chain';
import { runValidationChain } from '@readywork/app-validation';

/**
 * V1 验证链（InMemoryAgentAdapter 确定性桩）：
 * 创建员工 → 给权限 → 给业务任务 → AI执行 → 等待 → 恢复 → 调工具 → 人工审批 → 完成 → 评测
 * 同一条链也由 apps/demo-dsh 用 DeepSeekHarnessAdapter 跑（业务层零改动）。
 */

const BANNER = `
╔══════════════════════════════════════════════════════════════════╗
║   readywork — AI Workforce OS · V1 验证链                         ║
║   Agent: InMemoryAgentAdapter（确定性桩）                         ║
║   创建员工 → 权限 → 任务 → AI执行 → 等待 → 恢复 → 调工具          ║
║   → 人工审批 → 完成 → 评测                                        ║
╚══════════════════════════════════════════════════════════════════╝`;

async function main(): Promise<void> {
  console.log(BANNER);
  const rt = createSupplyChainRuntime({ logger: (l) => console.log('      ', l) });
  await runValidationChain(rt);
  console.log('\n  完成 — AI Employee Factory + AI Workforce Runtime 就绪。');
}

void main().catch((err) => {
  console.error('\n❌ 验证链失败:', err);
  process.exit(1);
});
