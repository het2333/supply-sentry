import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NodeExecutionResult } from '@readywork/graph-runtime';
import { createProcurementNodeFactory, procurementNodeAsset, procurementNodeExecutorResolver } from '@readywork/supply-chain';

async function execute(input: Record<string, unknown>): Promise<NodeExecutionResult> {
  const asset = procurementNodeAsset('ai:reply-parse')!;
  const factory = createProcurementNodeFactory(procurementNodeExecutorResolver());
  return factory.create({ id: 'reply:parse', type: asset.descriptor.type, typeVersion: asset.descriptor.version, name: asset.descriptor.name }).execute(
    { id: 'reply:parse', type: asset.descriptor.type, typeVersion: asset.descriptor.version, name: asset.descriptor.name },
    input,
    { tenantId: 't:1', employeeId: 'ai:procurement', workflowId: 'wf:po', workflowVersionId: 'v1', runId: 'run:1', nodeRunId: 'node:1', mode: 'autonomous', variables: input, credentials: {} },
  );
}

test('供应商回复节点：确定性提取 P00021 数量/日期并显式保留历史歧义', async () => {
  const result = await execute({
    message: { id: 'communication:new', body: '要改为8.10号了，只能交一半', receivedAt: '2026-08-30T08:00:00.000Z' },
    earlierCommunications: [{ id: 'communication:old', body: '要823，只能交一半' }],
    poLines: [{ id: 'line:1', orderedQty: 300, unitPrice: 80, requestedAt: '2026-08-09T16:00:00.000Z' }],
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.outputs['intent'], 'confirmed');
  const facts = result.outputs['facts'] as {
    strategy: string;
    lineSuggestions: Array<{ quantity?: { value: number }; promisedDate?: { value: string } }>;
    conflicts: Array<{ code: string; raw: string }>;
    missingFields: string[];
  };
  assert.equal(facts.strategy, 'deterministic_v1');
  assert.equal(facts.lineSuggestions[0]?.quantity?.value, 150);
  assert.equal(facts.lineSuggestions[0]?.promisedDate?.value, '2026-08-10');
  assert.deepEqual(facts.missingFields, ['unit_price']);
  assert.ok(facts.conflicts.some((conflict) => conflict.code === 'ambiguous_compact_date' && conflict.raw === '823'));
});

test('供应商回复节点：没有 PO 行时不制造可提交的行级事实', async () => {
  const result = await execute({ message: { body: '只能交一半，交期改为8月10日' }, referenceYear: 2026 });
  const facts = result.outputs['facts'] as { lineSuggestions: unknown[]; conflicts: Array<{ code: string }> };
  assert.deepEqual(facts.lineSuggestions, []);
  assert.ok(facts.conflicts.some((conflict) => conflict.code === 'ambiguous_line_scope'));
});
