import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeepSeekHarnessAdapter } from '@readywork/agent';
import { createMockModelServer } from '@readywork/app-mock-model';
import { runValidationChain } from '@readywork/app-validation';
import { createSupplyChainRuntime } from '@readywork/supply-chain';

/**
 * V1.5 验证：DeepSeek Harness Adapter 重跑同一条验证链。
 *
 * 运行方式：
 *   pnpm demo:dsh
 *
 * 无 DEEPSEEK_API_KEY 时自动在本机起一个 OpenAI 兼容 mock 模型端点（脚本化决策），
 * DeepSeek Harness runtime 完整真实运行（session / agent loop / 事件流），只是模型调用打到 mock。
 * 设置真实 DEEPSEEK_API_KEY 环境变量时，把 DEEPSEEK_BASE_URL 指向真实服务即可（决策不再确定，
 * 建议仅验证链路本身）。
 */

const BANNER = `
╔══════════════════════════════════════════════════════════════════╗
║   readywork — AI Workforce OS · V1.5 DSH Adapter 验证             ║
║   Agent: DeepSeekHarnessAdapter（真实 DSH runtime 子进程）        ║
║   无 key → mock-model（OpenAI 兼容端点，脚本化决策）              ║
║   业务层与 pnpm demo 完全相同（共享 apps/validation 验证链）      ║
╚══════════════════════════════════════════════════════════════════╝`;

async function main(): Promise<void> {
  const repo = process.env['DSH_REPO'] ?? '/Users/etheralia/Downloads/deepseek-harness-master';
  const apiKey = process.env['DEEPSEEK_API_KEY'];
  const baseUrl = process.env['DEEPSEEK_BASE_URL'];

  console.log(BANNER);
  console.log(`  DSH runtime: ${join(repo, 'packages/examples/jsonrpc-demo/src/bin.ts')}`);

  // 无 key：起 mock 模型端点；有 key：直连真实服务
  const mock = apiKey || baseUrl ? undefined : await createMockModelServer({ logger: (l) => console.log('     ', l) });
  const effectiveBaseUrl = baseUrl ?? mock?.url;
  console.log(`  LLM 端点: ${effectiveBaseUrl}（${apiKey ? '真实 API key' : 'mock-model 脚本化决策'}）`);

  const workspace = mkdtempSync(join(tmpdir(), 'rw-dsh-'));
  const adapter = new DeepSeekHarnessAdapter({
    runtimeOptions: {
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        join(repo, 'packages/examples/jsonrpc-demo/src/bin.ts'),
        join(repo, 'examples/jsonrpc-agent/cordis.yml'),
      ],
      cwd: repo,
      env: {
        DEEPSEEK_API_KEY: apiKey ?? 'demo-mock-key',
        ...(effectiveBaseUrl ? { DEEPSEEK_BASE_URL: effectiveBaseUrl } : {}),
        DSH_CWD: workspace,
        DSH_SESSION_ROOT: join(workspace, '.sessions'),
      },
      model: 'deepseek-v4-flash',
      initializeTimeoutMs: 120_000,
      turnTimeoutMs: 180_000,
    },
    logger: (l) => console.log('     ', l),
  });

  const rt = createSupplyChainRuntime({ agent: adapter, logger: (l) => console.log('      ', l) });
  try {
    const started = Date.now();
    await runValidationChain(rt, { waitTimeoutMs: 180_000 });
    console.log(`\n  完成 — DeepSeek Harness Adapter 跑通验证链（耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
    console.log(`  mock-model 请求数: ${mock ? mock.requestCount() : 'n/a（真实服务）'}`);
  } finally {
    await adapter.close().catch(() => {});
    await mock?.close().catch(() => {});
  }
}

void main().catch((err) => {
  console.error('\n❌ DSH 验证链失败:', err);
  process.exit(1);
});
