import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = readFileSync(
  fileURLToPath(new URL("../features/procurement/sla-workbench.tsx", import.meta.url)),
  "utf8",
);

test("SLA Web: 主视图使用 Navisight 公开规则目录骨架", () => {
  assert.match(source, /min-w-\[1040px\]/);
  assert.match(source, /colSpan=\{8\}/);
  assert.match(source, /addRuleFromDirectory/);
  assert.match(source, /READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS/);
  assert.match(source, /data-preserve-language[^>]*>\{rule\.name\}/);
  assert.match(source, /data-preserve-language[^>]*className="truncate">\{rule\.description\}/);
});

test("SLA Web: 规则仍来自版本化真实 API，未发布编辑不伪装生效", () => {
  assert.match(source, /api\/procurement\/sla/);
  assert.match(source, /api\/procurement\/sla\/policies/);
  assert.match(source, /directoryRules = useMemo/);
  assert.match(source, /selectedDraft \? draftRules/);
  assert.match(source, /expectedVersion: selectedDraft\.version/);
  assert.match(source, /草稿 v\$\{selectedDraft\.version\}/);
});

test("SLA Web: 发布、运行、影响和审计保留在渐进披露层", () => {
  assert.match(source, /策略治理与运行/);
  assert.doesNotMatch(source, /Policy Governance & Runtime/);
  assert.match(source, /const \[governanceOpen, setGovernanceOpen\] = useState\(false\)/);
  assert.match(source, /publishDraft/);
  assert.match(source, /runAutomation/);
  assert.match(source, /SlaEvaluationHistory/);
  assert.match(source, /selectedImpact/);
});

test("SLA Web: Add/Edit 使用桌面弹窗，行尾动作对齐编辑与更多菜单", () => {
  assert.match(source, /function SlaRuleEditorDialog/);
  assert.match(source, /aria-labelledby="sla-rule-editor-title"/);
  assert.match(source, /aria-label="更多操作"/);
  assert.match(source, /role="menu"/);
  assert.match(source, /editor\.mode === "add"/);
  assert.match(source, /onSubmit=\{\(event\) =>/);
  assert.doesNotMatch(source, /aria-label="Refresh SLA rules"/);
  assert.doesNotMatch(source, />Advanced options</);
});

test("SLA Web: 弹窗编辑仍遵守版本化草稿与诚实持久化边界", () => {
  assert.match(source, /async function persistDerivedDraft/);
  assert.match(source, /expectedVersion: selectedDraft\.version/);
  assert.match(source, /当前已发布策略没有被删除/);
});
