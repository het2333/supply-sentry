import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/home-dashboard.tsx", import.meta.url)),
  "utf8",
);

test("Overview Web: 日期查看与实时刷新保持纯读取", () => {
  assert.doesNotMatch(source, /risk-dashboard\/refresh/);
  assert.doesNotMatch(source, /method:\s*["']POST["']/);
  assert.match(source, /api\/procurement\/workbench\?limit=100/);
  assert.match(source, /api\/procurement\/risk-dashboard\?from=/);
  assert.match(source, /overviewMetricSeries/);
  assert.match(source, /history\?\.freshness/);
});
