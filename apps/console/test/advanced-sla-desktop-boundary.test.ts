import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/advanced-sla-workbench.tsx", import.meta.url)),
  "utf8",
);

// Desktop labels, domain navigation, dialogs and CSV actions are exercised by
// advanced-sla-workbench-interaction.test.tsx without the global translator.
test("Advanced SLA Web: preserves real persistence, validation, version and impact contracts", () => {
  assert.match(source, /fetchDashboard/);
  assert.match(source, /mutationStateAfterReload/);
  assert.match(source, /validateEditorState/);
  assert.match(source, /view\.importHistory/);
  assert.match(source, /view\.events/);
  assert.match(source, /view\.impact\.matchedPurchaseOrders/);
  assert.doesNotMatch(source, /Example supplier|mockRules|fakeRules/);
});

test("Advanced SLA Web: external side effects remain behind explicit versioned actions", () => {
  assert.match(source, /expectedVersion: view\.draft\.version/);
  assert.match(source, /expectedBatchVersion: importPreview\.version/);
  assert.match(source, /expectedProfileVersion: importPreview\.profileVersion/);
  assert.match(source, /expectedCandidateHash: importPreview\.candidateHash/);
  assert.match(source, /schemaVersion: 2/);
  assert.doesNotMatch(source, /scope_json|parameters_json/);
});
