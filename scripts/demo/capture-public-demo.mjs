#!/usr/bin/env node

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve(import.meta.dirname, '../..');
const storyPath = resolve(root, 'scripts/demo/capture-story.json');
const outputDirectory = resolve(root, process.env.READYWORK_DEMO_CAPTURE_DIR ?? 'artifacts/media/supplysentry-demo');
const baseUrl = new URL(process.env.READYWORK_DEMO_BASE_URL ?? 'http://127.0.0.1:3002/');
const allowedHosts = new Set(['127.0.0.1', 'localhost']);
const chromePath = process.env.READYWORK_CAPTURE_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!allowedHosts.has(baseUrl.hostname)) {
  throw new Error(`Capture host ${baseUrl.hostname} is forbidden; capture only the locally verified public-demo stack`);
}

const story = JSON.parse(await readFile(storyPath, 'utf8'));
if (story.tenantId !== 't:public-demo') throw new Error('Capture story must be bound to t:public-demo');

await mkdir(outputDirectory, { recursive: true });
for (let index = 0; index < story.scenes.length; index += 1) {
  await rm(resolve(outputDirectory, `scene-${String(index + 1).padStart(2, '0')}.png`), { force: true });
}

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const context = await browser.newContext({
  viewport: story.viewport,
  deviceScaleFactor: 1,
  locale: 'en-US',
  timezoneId: 'Asia/Shanghai',
  colorScheme: 'light',
  reducedMotion: 'reduce',
});
const page = await context.newPage();
const captured = [];
let verifiedStatus = null;

async function waitForStablePage() {
  await page.waitForLoadState('domcontentloaded');
  await page.locator('[data-public-demo-banner]').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(1_200);
}

async function addCaption(scene) {
  await page.evaluate(({ title, subtitle }) => {
    document.querySelector('[data-capture-caption]')?.remove();
    const caption = document.createElement('section');
    caption.dataset.captureCaption = 'true';
    caption.setAttribute('aria-label', 'Demo scene caption');
    caption.style.cssText = [
      'position:fixed', 'left:28px', 'bottom:24px', 'z-index:2147483647',
      'max-width:720px', 'padding:14px 18px', 'border-radius:14px',
      'background:rgba(15,23,42,.92)', 'color:#fff',
      'box-shadow:0 12px 32px rgba(15,23,42,.24)',
      'font-family:Inter,ui-sans-serif,system-ui,sans-serif', 'pointer-events:none',
    ].join(';');
    const heading = document.createElement('strong');
    heading.textContent = title;
    heading.style.cssText = 'display:block;font-size:20px;line-height:1.25;letter-spacing:-.01em';
    const detail = document.createElement('span');
    detail.textContent = subtitle;
    detail.style.cssText = 'display:block;margin-top:5px;font-size:13px;line-height:1.4;color:#cbd5e1';
    caption.append(heading, detail);
    document.body.append(caption);
  }, { title: scene.title, subtitle: scene.subtitle });
}

try {
  for (let index = 0; index < story.scenes.length; index += 1) {
    const scene = story.scenes[index];
    if (index === 0) {
      await page.goto(new URL(scene.route, baseUrl).href, { waitUntil: 'domcontentloaded' });
    } else if (index > 1) {
      await page.evaluate((route) => {
        window.history.pushState(null, '', route);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, scene.route);
    }
    await waitForStablePage();
    await page.getByRole('heading', { name: new RegExp(scene.expectedHeading, 'iu') }).first().waitFor({ state: 'visible', timeout: 15_000 });

    if (scene.action === 'enter-public-demo') {
      await addCaption(scene);
    } else {
      if (verifiedStatus?.tenantId !== 't:public-demo') throw new Error(`${scene.id}: public-demo session is missing`);
      await addCaption(scene);
    }

    const fileName = `scene-${String(index + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: resolve(outputDirectory, fileName), fullPage: false });
    captured.push({
      id: scene.id,
      route: scene.route,
      action: scene.action,
      durationSeconds: scene.durationSeconds,
      file: fileName,
      bannerVisible: true,
      tenantId: 't:public-demo',
    });

    if (scene.action === 'enter-public-demo') {
      const enter = page.getByRole('button', { name: /Enter Public Demo|\u8fdb\u5165\u516c\u5f00\u6f14\u793a/iu });
      await enter.click();
      await page.waitForFunction(async () => {
        const response = await fetch('/api/public-demo/status');
        if (!response.ok) return false;
        const status = await response.json();
        return status.tenantId === 't:public-demo';
      }, undefined, { timeout: 15_000 });
      verifiedStatus = await page.evaluate(async () => {
        const response = await fetch('/api/public-demo/status');
        return response.ok ? response.json() : null;
      });
      if (verifiedStatus?.tenantId !== 't:public-demo') throw new Error('Public-demo tenant verification failed after entry');
      await waitForStablePage();
    }
  }
} finally {
  await context.close();
  await browser.close();
}

const generation = verifiedStatus?.generation ?? null;

const manifest = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  story: story.name,
  notice: story.notice,
  baseHost: baseUrl.hostname,
  tenantId: story.tenantId,
  generation,
  viewport: story.viewport,
  durationSeconds: captured.reduce((sum, scene) => sum + scene.durationSeconds, 0),
  scenes: captured,
};

await writeFile(resolve(outputDirectory, 'capture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const concat = ['ffconcat version 1.0'];
for (const scene of captured) {
  concat.push(`file '${scene.file}'`, `duration ${scene.durationSeconds}`);
}
concat.push(`file '${captured.at(-1).file}'`, 'duration 0.04');
await writeFile(resolve(outputDirectory, 'frames.ffconcat'), `${concat.join('\n')}\n`);
await writeFile(resolve(outputDirectory, 'poster.png'), await readFile(resolve(outputDirectory, captured[1]?.file ?? captured[0].file)));
console.log(JSON.stringify({ ok: true, outputDirectory, scenes: captured.length, durationSeconds: manifest.durationSeconds }, null, 2));
