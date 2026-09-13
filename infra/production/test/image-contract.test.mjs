import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dockerfileUrl = new URL('../Dockerfile', import.meta.url);

test('production image is pinned, reproducible, secret-free, and runs unprivileged', async () => {
  const source = await readFile(dockerfileUrl, 'utf8');

  assert.match(source, /^FROM node:24\.20\.0-bookworm-slim AS dependencies$/m);
  assert.match(source, /^FROM node:24\.20\.0-bookworm-slim AS readywork-app$/m);
  assert.match(source, /corepack prepare pnpm@11\.7\.0 --activate/);
  assert.match(source, /pnpm install --frozen-lockfile/);
  assert.match(source, /pnpm --filter @readywork\/app-console build/);
  assert.match(source, /^USER readywork$/m);
  assert.match(source, /org\.opencontainers\.image\.source/);
  assert.match(source, /org\.opencontainers\.image\.revision/);
  assert.doesNotMatch(source, /COPY\s+[^\n]*\.env/i);
  assert.doesNotMatch(source, /READYWORK_(?:SESSION_SECRET|CREDENTIAL_KEY)\s*=/);
});
