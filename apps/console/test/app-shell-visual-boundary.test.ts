import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { READYWORK_PROCUREMENT_VISUAL_TOKENS } from '../features/procurement/visual-tokens.js';
import * as visualTokens from '../features/procurement/visual-tokens.js';

const pageSource = readFileSync(fileURLToPath(new URL('../app/page.tsx', import.meta.url)), 'utf8');
const globalCss = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8');
const nextConfigSource = readFileSync(fileURLToPath(new URL('../next.config.ts', import.meta.url)), 'utf8');
const advancedSlaSource = readFileSync(fileURLToPath(new URL('../features/procurement/advanced-sla-workbench.tsx', import.meta.url)), 'utf8');
const globalHeaderSource = readFileSync(fileURLToPath(new URL('../features/procurement/global-header.tsx', import.meta.url)), 'utf8');

test('Navisight desktop shell: sidebar uses the verified floating-card geometry', () => {
  assert.equal(READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarExpandedPx, 248);
  assert.equal(READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarCollapsedPx, 76);
  assert.equal(READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarOuterPaddingPx, 12);
  assert.equal(READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarPanelRadiusPx, 24);
  assert.equal(READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarHeaderHeightPx, 68);
  assert.match(pageSource, /padding: READYWORK_PROCUREMENT_VISUAL_TOKENS\.sidebarOuterPaddingPx/);
  assert.match(pageSource, /borderRadius: READYWORK_PROCUREMENT_VISUAL_TOKENS\.sidebarPanelRadiusPx/);
  assert.match(pageSource, /height: READYWORK_PROCUREMENT_VISUAL_TOKENS\.sidebarHeaderHeightPx/);
  assert.match(pageSource, /overflow-hidden border border-\[#e2e8f0\] bg-white shadow-/);
});

test('Navisight desktop shell: navigation density and first-group hierarchy match the public app', () => {
  assert.match(pageSource, /buildEmployeePackSidebarGroups/);
  assert.match(pageSource, /group\.label && group\.id !== "work"/);
  assert.match(pageSource, /rounded-xl px-3 py-2 text-\[13\.5px\]/);
  assert.match(pageSource, /size-\[18px\] shrink-0/);
  assert.doesNotMatch(pageSource, /sticky top-0 hidden h-screen shrink-0 flex-col border-r border-\[#eef2f7\] bg-white\/95/);
  assert.match(pageSource, /aria-label=\{sidebarOpen \? "收起导航" : "展开导航"\}/);
  assert.doesNotMatch(globalCss, /button,\s*\ninput\s*\{\s*font:\s*inherit/);
  assert.match(globalCss, /button,\s*\ninput,\s*\nselect,\s*\ntextarea\s*\{\s*font-family:\s*inherit/);
});

test('Navisight desktop shell: root clips only the horizontal axis so sticky navigation remains viewport-bound', () => {
  assert.match(pageSource, /min-h-screen overflow-x-clip text-slate-950/);
  assert.doesNotMatch(pageSource, /min-h-screen overflow-x-hidden text-slate-950/);
  assert.match(nextConfigSource, /devIndicators:\s*false/);
});

test('Readywork procurement shell: business sidebar excludes developer navigation', () => {
  assert.match(pageSource, /themeId === "readywork-procurement"/);
  assert.doesNotMatch(pageSource, /activePack\?\.interfaces\.developer\.enabled && <div className="border-t/);
  assert.doesNotMatch(pageSource, />流程图</);
  assert.match(pageSource, /navigateToSection\("employees", \{ viewMode: "developer" \}\)/);
});

test('purchase-order deep links integrate the global controls into the reference-style page header', () => {
  const presentation = (visualTokens as unknown as {
    procurementHeaderPresentation?: (input: { section: string; purchaseOrderId: string | null }) => { integrated: boolean; showSearch: boolean };
  }).procurementHeaderPresentation;
  assert.equal(typeof presentation, 'function', 'the shell must derive header presentation from the active deep link');
  assert.deepEqual(presentation!({ section: 'orders', purchaseOrderId: 'po:1' }), { integrated: true, showSearch: false });
  assert.deepEqual(presentation!({ section: 'orders', purchaseOrderId: null }), { integrated: false, showSearch: true });
  assert.deepEqual(presentation!({ section: 'local-procurement', purchaseOrderId: null }), { integrated: true, showSearch: false });
});

test('directory and configuration pages integrate global controls without a duplicate search row', () => {
  const presentation = (visualTokens as unknown as {
    procurementHeaderPresentation?: (input: { section: string; purchaseOrderId: string | null }) => { integrated: boolean; showSearch: boolean };
  }).procurementHeaderPresentation;
  assert.equal(typeof presentation, 'function', 'the shell must derive header presentation from the active section');

  for (const section of ['suppliers', 'sla', 'advanced-sla', 'settings']) {
    assert.deepEqual(
      presentation!({ section, purchaseOrderId: null }),
      { integrated: true, showSearch: false },
      `${section} must keep the global actions in its page header without rendering a second title/search row`,
    );
  }
  assert.equal(
    (visualTokens as unknown as { READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS?: string }).READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS,
    'xl:pr-[200px]',
  );
  assert.match(advancedSlaSource, /READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS/);
});

test('integrated desktop header matches the measured compact reference controls', () => {
  assert.match(globalHeaderSource, /xl:right-7/);
  assert.match(globalHeaderSource, /xl:gap-2\.5/);
  assert.match(globalHeaderSource, /xl:w-\[200px\] xl:max-w-\[200px\] xl:flex-none/);
  assert.match(globalHeaderSource, /integrated && "xl:h-9"/);
  assert.match(globalHeaderSource, /integrated && "xl:size-9"/);
  assert.match(globalHeaderSource, /integrated && "xl:h-\[38px\] xl:w-\[146px\]"/);
});
