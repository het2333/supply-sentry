import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
}

const productionFiles = [
  "../app/product/page.tsx",
  "../app/product/layout.tsx",
  "../app/privacy/page.tsx",
  "../app/terms/page.tsx",
  "../features/marketing/legal-page.tsx",
  "../../../packages/supply-chain/src/procurement-employee-pack.ts",
];

const workspaceBrandFiles = [
  "../app/layout.tsx",
  "../app/page.tsx",
  "../features/procurement/route-chat.tsx",
  "../features/procurement/route-workbench.tsx",
  "../features/procurement/ap-workbench.tsx",
];

test("public production surfaces use only the Readywork product brand", () => {
  for (const relative of productionFiles) {
    assert.doesNotMatch(source(relative), /navisight(?:\.ai)?/i, relative);
  }

  const layout = source("../app/product/layout.tsx");
  const form = source("../app/product/demo-request-form.tsx");
  assert.match(layout, /title:\s*"Readywork/);
  assert.match(form, /`readywork-demo:\$\{window\.crypto\.randomUUID\(\)\}`/);
});

test("authenticated workspace surfaces use the Readywork product brand only", () => {
  for (const relative of workspaceBrandFiles) {
    assert.doesNotMatch(source(relative), /Navi(?:Sight)? Assistant|ReadyCrew/i, relative);
  }
  assert.match(source("../app/layout.tsx"), /title:\s*"Readywork — 采购执行工作区"/);
});

test("public product visuals are self-owned local assets or React geometry", () => {
  const mark = fileURLToPath(new URL("../public/readywork/readywork-mark.svg", import.meta.url));
  const visualsPath = fileURLToPath(new URL("../features/marketing/readywork-product-visuals.tsx", import.meta.url));
  const product = source("../app/product/page.tsx");

  assert.equal(existsSync(mark), true, "Readywork mark must be bundled under /public/readywork");
  assert.equal(existsSync(visualsPath), true, "Readywork product visuals must be local React components");
  const visuals = readFileSync(visualsPath, "utf8");
  assert.match(product, /src="\/readywork\/readywork-mark\.svg"/);
  assert.match(product, /<ReadyworkProductVisual kind="overview" \/>/);
  assert.match(product, /<ReadyworkProductVisual kind="notifications" \/>/);
  assert.match(product, /<ReadyworkProductVisual kind="drafted-emails" \/>/);
  assert.match(product, /<ReadyworkProductVisual kind="po-timeline" \/>/);
  assert.match(product, /<ReadyworkProductVisual kind="risk-dashboard" \/>/);
  assert.match(product, /<ReadyworkProductVisual kind="route-local" \/>/);
  assert.match(product, /<ReadyworkProductVisual kind="route-import" \/>/);
  assert.match(visuals, /export type ReadyworkProductVisual/);
  assert.match(visuals, /暂无持久化数据/);
  assert.match(visuals, /需要证据/);
  assert.doesNotMatch(`${product}\n${visuals}`, /https?:\/\//);
});
