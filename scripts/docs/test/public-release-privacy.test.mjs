import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const run = promisify(execFile);
const root = new URL('../../../', import.meta.url);

test('tracked public-release files contain no known real recipient contact', async () => {
  const forbiddenContact = `2394818851${'@'}`;
  const result = await run('git', ['grep', '-n', '-F', forbiddenContact, '--', '.'], {
    cwd: decodeURIComponent(root.pathname),
  }).catch((error) => error);
  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  assert.equal(stdout, '', `known real recipient contact remains in tracked files:\n${stdout}`);
});
