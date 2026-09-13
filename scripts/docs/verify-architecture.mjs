#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourcePath = new URL('../../docs/architecture/supplysentry-system.drawio', import.meta.url);
const svgPath = new URL('../../docs/architecture/supplysentry-system.svg', import.meta.url);
const [source, svg] = await Promise.all([readFile(sourcePath, 'utf8'), readFile(svgPath, 'utf8')]);

const labels = [
  'SupplySentry Runtime', 'Messaging &amp; Enterprise Integrations', 'Durable Evidence &amp; State',
  'Model proposes; business runtime decides', 'simulated_demo', 'Action Gateway', 'Hermes Gateway',
];
for (const label of labels) assert.ok(source.includes(label), `architecture source is missing: ${label}`);
assert.match(svg, /viewBox="0 0 \d+ \d+"/u);
assert.doesNotMatch(svg, /<image[^>]+https?:/u);
for (const label of ['SupplySentry Runtime', 'Model proposes; business runtime decides', 'simulated_demo']) {
  assert.ok(svg.includes(label), `architecture SVG is missing: ${label}`);
}
console.log(JSON.stringify({ ok: true, source: 'docs/architecture/supplysentry-system.drawio', svg: 'docs/architecture/supplysentry-system.svg', labels: labels.length, externalImages: 0 }, null, 2));
