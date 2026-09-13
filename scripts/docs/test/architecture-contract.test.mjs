import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

test('editable architecture source names the decision and public-demo boundaries', async () => {
  const source = await read('docs/architecture/supplysentry-system.drawio');
  for (const label of [
    'SupplySentry Runtime', 'Temporal Worker', 'Supplier Reply AI', 'Policy + Human Approval',
    'Action Gateway', 'Hermes Gateway', 'Inbox / Outbox / Audit',
    'Model proposes; business runtime decides', 'simulated_demo',
  ]) assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'), `missing ${label}`);
  assert.doesNotMatch(source, /<mxCell[^>]+style="[^"]*image=/u);
});

test('exported SVG is self-contained and responsive', async () => {
  const svg = await read('docs/architecture/supplysentry-system.svg');
  assert.match(svg, /<svg[^>]+viewBox="0 0 \d+ \d+"/u);
  assert.match(svg, /SupplySentry/u);
  assert.match(svg, /Model proposes; business runtime decides/u);
  assert.match(svg, /simulated_demo/u);
  assert.doesNotMatch(svg, /<image[^>]+https?:/u);
});
