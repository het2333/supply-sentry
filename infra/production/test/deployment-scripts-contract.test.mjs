import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(decodeURIComponent(new URL('../../../', import.meta.url).pathname));
const creator = join(repositoryRoot, 'scripts/deploy/create-preview-bundle.sh');
const verifier = join(repositoryRoot, 'scripts/deploy/verify-preview-data.sh');

test('bundle creation is consistent, secret-free, and server verification refuses overwrite', async () => {
  const sourceDb = join(repositoryRoot, 'data/readywork.sqlite');
  const before = await stat(sourceDb);
  const output = await mkdtemp(join(tmpdir(), 'readywork-bundle-output-'));
  const serverRoot = await mkdtemp(join(tmpdir(), 'readywork-server-root-'));

  const created = spawnSync(creator, [output, 'contract-release'], { cwd: repositoryRoot, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const archive = join(output, 'readywork-contract-release.tar.gz');
  const manifest = join(output, 'readywork-contract-release.SHA256SUMS');
  await stat(archive);
  await stat(manifest);

  const verified = spawnSync(verifier, [archive, manifest, serverRoot, 'contract-release'], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.match(verified.stdout, /SQLite integrity: ok/);
  await stat(join(serverRoot, 'releases/contract-release/app/package.json'));
  await stat(join(serverRoot, 'releases/contract-release/data/readywork.sqlite'));

  const files = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
  assert.equal(files.status, 0, files.stderr);
  assert.doesNotMatch(files.stdout, /(?:^|\/)\.env(?:\.|$)|credential-key|node_modules|\.next|(?:^|\/)logs?(?:\/|$)|\.sqlite-(?:wal|shm)$/);
  assert.doesNotMatch(files.stdout, /(?:^|\/)\._/, 'macOS AppleDouble metadata must not enter Linux releases');

  const second = spawnSync(verifier, [archive, manifest, serverRoot, 'contract-release'], { encoding: 'utf8' });
  assert.notEqual(second.status, 0, 'existing release must not be overwritten');

  const after = await stat(sourceDb);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);

  const creatorSource = await readFile(creator, 'utf8');
  const verifierSource = await readFile(verifier, 'utf8');
  assert.match(creatorSource, /^set -euo pipefail$/m);
  assert.match(verifierSource, /^set -euo pipefail$/m);
  assert.doesNotMatch(`${creatorSource}\n${verifierSource}`, /rm\s+-rf/);
});
