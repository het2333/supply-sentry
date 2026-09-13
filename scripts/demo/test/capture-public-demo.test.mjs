import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');
const run = promisify(execFile);

test('capture story is deterministic, synthetic, and privacy-safe', async () => {
  const story = JSON.parse(await read('scripts/demo/capture-story.json'));
  assert.deepEqual(story.viewport, { width: 1440, height: 900 });
  assert.equal(story.tenantId, 't:public-demo');
  assert.equal(story.language, 'en');
  assert.ok(story.scenes.length >= 7);
  assert.ok(story.scenes.every((scene) => scene.durationSeconds >= 3 && scene.durationSeconds <= 12));
  assert.ok(story.scenes.every((scene) => typeof scene.expectedHeading === 'string' && scene.expectedHeading.length > 2));
  assert.ok(story.scenes.some((scene) => scene.action === 'enter-public-demo'));
  assert.ok(story.scenes.some((scene) => scene.route.includes('vague-reply')));
  assert.ok(story.scenes.some((scene) => scene.route.includes('awaiting-confirmation')));
  assert.ok(story.scenes.some((scene) => scene.route.includes('notifications')));

  const serialized = JSON.stringify(story);
  assert.doesNotMatch(serialized, /47\.102\.116\.148|novagent|t:acme|@qq\.com|sk-[a-z0-9]{12,}|password|authorization/i);
  assert.match(serialized, /synthetic|public demo/i);
});

test('capture and verifier enforce the public-demo banner and safe host policy', async () => {
  const [capture, verifier, renderer] = await Promise.all([
    read('scripts/demo/capture-public-demo.mjs'),
    read('scripts/demo/verify-public-demo-media.mjs'),
    read('scripts/demo/render-public-demo-media.sh'),
  ]);
  assert.match(capture, /data-public-demo-banner/);
  assert.match(capture, /t:public-demo/);
  assert.match(capture, /127\.0\.0\.1|localhost/);
  assert.match(capture, /page\.goto\(new URL\([^\n]+\)\.href/);
  assert.match(capture, /Enter Public Demo\|\\u8fdb\\u5165\\u516c\\u5f00\\u6f14\\u793a\/iu/);
  assert.match(capture, /waitForFunction[\s\S]+status\.tenantId === 't:public-demo'/);
  assert.match(capture, /history\.pushState/);
  assert.match(capture, /PopStateEvent/);
  assert.match(capture, /scene\.expectedHeading/);
  assert.match(capture, /concat\.push\(`file '\$\{captured\.at\(-1\)\.file\}'`, 'duration 0\.04'\)/);
  assert.match(verifier, /capture-manifest\.json/);
  assert.match(verifier, /forbidden/i);
  assert.match(renderer, /ffmpeg/);
  assert.match(renderer, /1920:1080/);
  assert.match(renderer, /supplysentry-demo-poster\.png/);
  assert.match(renderer, /-t "\$duration"/);
});

test('media renderer accepts the documented source.webm path and resolves its capture directory', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'supplysentry-media-render-'));
  const scriptDirectory = join(workspace, 'scripts', 'demo');
  const captureDirectory = join(workspace, 'artifacts', 'media', 'supplysentry-demo');
  const fakeBin = join(workspace, 'fake-bin');
  await Promise.all([
    mkdir(scriptDirectory, { recursive: true }),
    mkdir(captureDirectory, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
  ]);
  const rendererPath = join(scriptDirectory, 'render-public-demo-media.sh');
  await copyFile(new URL('scripts/demo/render-public-demo-media.sh', root), rendererPath);
  await chmod(rendererPath, 0o755);
  await Promise.all([
    writeFile(join(captureDirectory, 'source.webm'), ''),
    writeFile(join(captureDirectory, 'frames.ffconcat'), 'ffconcat version 1.0\n'),
    writeFile(join(captureDirectory, 'capture-manifest.json'), '{"durationSeconds":61}\n'),
    writeFile(join(captureDirectory, 'poster.png'), 'synthetic-poster'),
    writeFile(join(fakeBin, 'node'), '#!/bin/sh\nprintf 61\n'),
    writeFile(join(fakeBin, 'ffmpeg'), '#!/bin/sh\nfor value do output=$value; done\nmkdir -p "$(dirname "$output")"\n: > "$output"\n'),
    writeFile(join(fakeBin, 'ffprobe'), '#!/bin/sh\nprintf "{}\\n"\n'),
  ]);
  await Promise.all(['node', 'ffmpeg', 'ffprobe'].map((name) => chmod(join(fakeBin, name), 0o755)));

  await run(rendererPath, [join(captureDirectory, 'source.webm')], {
    cwd: workspace,
    env: { ...process.env, PATH: `${fakeBin}:/bin:/usr/bin` },
  });

  await Promise.all([
    readFile(join(captureDirectory, 'supplysentry-walkthrough.mp4')),
    readFile(join(workspace, 'docs', 'assets', 'supplysentry-demo.gif')),
    readFile(join(workspace, 'docs', 'assets', 'supplysentry-demo-poster.png')),
  ]);
});
