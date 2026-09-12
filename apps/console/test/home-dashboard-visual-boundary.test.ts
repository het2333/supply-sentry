import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/home-dashboard.tsx", import.meta.url)),
  "utf8",
);
const globalStyles = readFileSync(
  fileURLToPath(new URL("../app/globals.css", import.meta.url)),
  "utf8",
);

test("Overview Web: keeps the Navisight desktop KPI composition", () => {
  assert.match(source, /grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6/);
  assert.match(source, /h-\[126\.5px\][^\n]*border-b border-\[#e5e9ef\]/);
  assert.match(source, /rounded-3xl border p-5 pb-\[22\.5px\] text-left/);
  assert.doesNotMatch(source, /(?:h|min-h)-\[(?:236|255\.5)px\] rounded-3xl border p-5 text-left/);
  assert.match(source, /flex flex-wrap items-center gap-2/);
  assert.doesNotMatch(source, /xl:w-\[(?:612|734)px\]/);
  assert.doesNotMatch(source, /xl:flex-nowrap/);
  assert.match(source, /flex h-full flex-col rounded-3xl border/);
  assert.doesNotMatch(source, /min-h-\[520px\]/);
  assert.match(source, /xl:grid-cols-\[minmax\(0,1fr\)_336px\]/);
  assert.match(source, /grid min-w-0 grid-cols-1 gap-5 lg:grid-cols-2/);
  assert.doesNotMatch(source, /min-\[1680px\]:grid-cols-\[minmax\(0,1fr\)_318px\]/);
  assert.doesNotMatch(globalStyles, /\.overview-route-grid/);
  assert.match(source, /w-full min-w-\[960px\] border-collapse text-left/);
  assert.match(source, /px-5 py-\[14px\]/);
  assert.match(source, /flex size-7 items-center justify-center rounded-lg/);
  assert.match(source, /hidden min-h-\[313\.875px\] flex-col rounded-3xl/);
  assert.match(globalStyles, /::-webkit-scrollbar\s*\{\s*width:\s*15px;\s*height:\s*11px;/);
});

test("Overview Web: does not add a mobile product surface", () => {
  assert.doesNotMatch(source, /mobile|bottom action|touch gesture|swipe/i);
});
