import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(decodeURIComponent(new URL('../../..', import.meta.url).pathname));

async function source(path) {
  try { return await readFile(resolve(root, path), 'utf8'); }
  catch { return ''; }
}

test('CI pins the toolchain and gates tests, localization, evaluation, seed, build, and container smoke', async () => {
  const workflow = await source('.github/workflows/ci.yml');
  assert.ok(workflow, 'CI workflow is missing');
  for (const pattern of [
    /node-version:\s*24\.20\.0/u,
    /version:\s*11\.7\.0/u,
    /pnpm install --frozen-lockfile/u,
    /pnpm typecheck/u,
    /pnpm test(?:\s|$)/mu,
    /pnpm test:localization/u,
    /infra\/demo\/test/u,
    /eval:supplier-replies:verify/u,
    /eval:supplier-replies:check/u,
    /seed-public-demo/u,
    /app-console build/u,
    /demo\.sh up --build/u,
  ]) assert.match(workflow, pattern);
});

test('GHCR workflow publishes immutable SHA/version tags and gates latest on mandatory verification', async () => {
  const workflow = await source('.github/workflows/demo-image.yml');
  assert.ok(workflow, 'demo image workflow is missing');
  assert.match(workflow, /packages:\s*write/u);
  assert.match(workflow, /ghcr\.io\/\$\{\{\s*github\.repository\s*\}\}/u);
  assert.match(workflow, /type=sha[^\n]*prefix=sha-/u);
  assert.match(workflow, /type=semver/u);
  assert.match(workflow, /org\.opencontainers\.image\.source/u);
  assert.match(workflow, /provenance:\s*true/u);
  assert.match(workflow, /latest/u);
  assert.match(workflow, /needs:\s*verify/u);
  assert.doesNotMatch(workflow, /pull_request:[\s\S]*DEEPSEEK_API_KEY/u);
});

test('server deployment is pinned to its isolated directory, project, and port', async () => {
  const deploy = await source('scripts/demo/deploy-server.sh');
  assert.ok(deploy, 'server deployment script is missing');
  assert.match(deploy, /^set -euo pipefail$/mu);
  assert.match(deploy, /\/opt\/supplysentry-demo/u);
  assert.match(deploy, /READYWORK_DEMO_BIND_ADDRESS=0\.0\.0\.0/u);
  assert.match(deploy, /READYWORK_DEMO_PORT=3002/u);
  assert.match(deploy, /--project-name supplysentry-demo/u);
  assert.match(deploy, /\/opt\/readywork\/shared/u);
  assert.match(deploy, /refus|拒绝|must be|只能/u);
  assert.doesNotMatch(deploy, /rm\s+-rf/u);
  assert.doesNotMatch(deploy, /READYWORK_DEMO_PORT=3001/u);
});

test('external verifier enters a public session, guards generation, exercises business state, simulation, denial, and reset', async () => {
  const verifier = await source('scripts/demo/verify-public-demo.mjs');
  assert.ok(verifier, 'external verifier is missing');
  for (const pattern of [
    /\/api\/auth\/public-demo/u,
    /x-readywork-demo-generation/u,
    /purchase-order:public-demo:/u,
    /\/api\/procurement\/execution\//u,
    /simulated_demo/u,
    /externalDelivery/u,
    /\/api\/procurement\/notifications/u,
    /\/internal\/demo\/reset/u,
    /PUBLIC_DEMO_CAPABILITY_DISABLED/u,
  ]) assert.match(verifier, pattern);
  assert.doesNotMatch(verifier, /sk-[A-Za-z0-9]{16,}|@qq\.com|\/opt\/readywork\/shared/u);
});
