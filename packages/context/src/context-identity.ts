import { createHash } from 'node:crypto';

export function stableTwinEntityId(tenantId: string, entityType: string, canonicalKey: string): string {
  const digest = createHash('sha256')
    .update(`${tenantId}\0${entityType}\0${canonicalKey}`)
    .digest('hex')
    .slice(0, 32);
  return `twin:${entityType}:${digest}`;
}

export function contextSourceWatermark(
  sources: readonly { sourceTable: string; sourceKey: string; sourceRevision: string; sourceHash: string }[],
): string {
  const normalized = [...sources].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
