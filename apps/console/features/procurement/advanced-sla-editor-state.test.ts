import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADVANCED_SLA_DOMAINS, ADVANCED_SLA_V2_PARAMETER_FIELDS, advancedSlaDependencyOptions, buildAdvancedSlaPatch, canRunMutation, createEditorState, mutationStateAfterReload, removeEditorRule, ruleParameterValue, updateEditorName, updateEditorRule, validateEditorState, type AdvancedSlaRuleV2, type AdvancedSlaProfileV2 } from "./advanced-sla-editor-state";
import { literalNineDomainV2Draft, literalNineDomainV2Sections } from "./advanced-sla-test-fixtures";

const profile = { ...literalNineDomainV2Draft, autoSend: { enabled: false, stages: [], channels: [], risks: [] }, sections: ADVANCED_SLA_DOMAINS.map((domain) => ({ domain, enabled: true, rules: [] })) } as unknown as AdvancedSlaProfileV2;
const productionRule = structuredClone(literalNineDomainV2Sections[0]!.rules[0]!) as AdvancedSlaRuleV2;

describe("advanced SLA v2 editor contract", () => {
  it("edits typed fields locally and preserves reference actor/time metadata in PATCH", () => {
    const state = createEditorState(profile);
    const next = updateEditorRule(state, "production_service_milestones", productionRule.ruleId, { ...productionRule, name: "Local v2", companyCode: "RW-DE", priority: 11 });
    assert.equal(next.dirty, true); assert.equal(buildAdvancedSlaPatch(state), null);
    const patch = buildAdvancedSlaPatch(next)!;
    assert.equal(patch.schemaVersion, 2); assert.equal(patch.expectedVersion, 4);
    const writable = patch.sections[0]!.rules[0] as unknown as Record<string, unknown>;
    assert.equal(writable["companyCode"], "RW-DE"); assert.equal(writable["createdBy"], "human:manager"); assert.equal(writable["approvedBy"], null); assert.equal(writable["lastUpdated"], "2026-09-03T04:00:00.000Z");
  });

  it("keeps form descriptors exactly aligned with every strict parameter family", () => {
    for (const domain of ADVANCED_SLA_DOMAINS) assert.ok(ADVANCED_SLA_V2_PARAMETER_FIELDS[domain].length > 0, domain);
    assert.ok(ADVANCED_SLA_V2_PARAMETER_FIELDS.logistics_planning.some((field) => field.key === "freightPlanningLeadTime" && field.section === "Lead Times"));
    assert.ok(ADVANCED_SLA_V2_PARAMETER_FIELDS.quality_inspection_grn.some((field) => field.key === "partialGrnAllowed" && field.kind === "select"));
  });

  it("rejects blank required common fields, invalid priority, overlap and incomplete auto-send allowlists", () => {
    let state = createEditorState(profile);
    state = updateEditorRule(state, "production_service_milestones", productionRule.ruleId, { ...productionRule, ruleId: "", priority: 1001 });
    assert.equal(validateEditorState(state).ok, false); assert.equal(buildAdvancedSlaPatch(state), null);
    assert.equal(validateEditorState({ ...createEditorState(profile), autoSend: { enabled: true, stages: [], channels: [], risks: [] } }).ok, false);
    const overlap = { ...productionRule, ruleId: "overlap", name: "Overlap" };
    state = updateEditorRule(createEditorState(profile), "production_service_milestones", productionRule.ruleId, productionRule);
    state = updateEditorRule(state, "production_service_milestones", overlap.ruleId, overlap);
    assert.match(validateEditorState(state).reason ?? "", /overlap/i);
  });

  it("uses real draft rules as dependency choices, rejects cycles, and removes deleted references", () => {
    if (productionRule.parameters.domain !== "production_service_milestones") assert.fail("wrong fixture domain");
    const parameters = productionRule.parameters;
    const first = { ...productionRule, ruleId: "milestone-a", name: "Start", parameters: { ...parameters, blockingRuleIds: [] } } as AdvancedSlaRuleV2;
    const second = { ...productionRule, ruleId: "milestone-b", name: "Complete", priority: 12, parameters: { ...parameters, milestoneSequence: 2, blockingRuleIds: [first.ruleId] } } as AdvancedSlaRuleV2;
    let state = updateEditorRule(createEditorState(profile), first.domain, first.ruleId, first);
    state = updateEditorRule(state, second.domain, second.ruleId, second);
    assert.deepEqual(advancedSlaDependencyOptions(state, second.ruleId).map((item) => item.id), [first.ruleId]); assert.equal(validateEditorState(state).ok, true);
    state = updateEditorRule(state, first.domain, first.ruleId, { ...first, parameters: { ...parameters, blockingRuleIds: [second.ruleId] } });
    assert.match(validateEditorState(state).reason ?? "", /cycle/i);
    state = updateEditorRule(state, first.domain, first.ruleId, first);
    const removed = removeEditorRule(state, first.domain, first.ruleId);
    assert.deepEqual(ruleParameterValue(removed.sections[0]!.rules[0]!, "blockingRuleIds"), []);
  });

  it("correlates v2 draft apply with batch/profile/candidate fences after authoritative reload", () => {
    const draftV5 = { ...literalNineDomainV2Draft, id: "draft-correlated", version: 5 };
    const draftV6 = { ...draftV5, version: 6 };
    const hash = "a".repeat(64);
    const batch = { id: "batch-correlated", profileId: draftV5.id, profileVersion: 5, version: 2, status: "applied", sourceName: "rules.csv", candidateHash: hash };
    const impactPreview = { candidateType: "import", candidateId: batch.id, candidateVersion: 1, profileId: draftV5.id, profileVersion: 5, activePurchaseOrders: 7, matchedPurchaseOrders: 3 } as const;
    const correlation = { action: "csv_apply", response: { item: draftV6, batch, impactPreview, replayed: false }, reloaded: { profiles: [draftV6], published: null, draft: draftV6, runtimeControl: null, importHistory: [batch] }, targetId: draftV5.id, expectedVersion: 5, batchId: batch.id, expectedBatchVersion: 1, expectedCandidateHash: hash, expectedImpactPreview: impactPreview } as const;
    assert.equal(mutationStateAfterReload(true, true, correlation).status, "success");
    assert.equal(mutationStateAfterReload(true, true, { ...correlation, expectedCandidateHash: "b".repeat(64) }).status, "error");
    assert.equal(mutationStateAfterReload(true, true, { ...correlation, response: { ...correlation.response, impactPreview: { ...impactPreview, candidateVersion: 2 } } }).status, "error");
  });

  it("correlates create/save/publish/retire/runtime and blocks unrelated dirty mutations", () => {
    const draftV5 = { ...literalNineDomainV2Draft, version: 5 }; const publishedV6 = { ...draftV5, status: "published" as const, version: 6 }; const retiredV7 = { ...publishedV6, status: "retired" as const, version: 7 };
    assert.equal(mutationStateAfterReload(true, true, { action: "save", response: { item: draftV5 }, reloaded: { profiles: [draftV5], published: null, draft: draftV5, runtimeControl: null, importHistory: [] }, targetId: draftV5.id, expectedVersion: 4 }).status, "success");
    assert.equal(mutationStateAfterReload(true, true, { action: "publish", response: { item: publishedV6 }, reloaded: { profiles: [publishedV6], published: publishedV6, draft: null, runtimeControl: null, importHistory: [] }, targetId: publishedV6.id, expectedVersion: 5 }).status, "success");
    assert.equal(mutationStateAfterReload(true, true, { action: "retire", response: { item: retiredV7 }, reloaded: { profiles: [retiredV7], published: null, draft: null, runtimeControl: null, importHistory: [] }, targetId: retiredV7.id, expectedVersion: 6 }).status, "success");
    const runtime = { profileId: publishedV6.id, profileVersion: 6, paused: true, version: 2 };
    assert.equal(mutationStateAfterReload(true, true, { action: "runtime", response: { item: runtime }, reloaded: { profiles: [publishedV6], published: publishedV6, draft: null, runtimeControl: runtime, importHistory: [] }, targetId: publishedV6.id, profileVersion: 6, expectedVersion: 1, paused: true }).status, "success");
    assert.equal(canRunMutation(true, "publish").ok, false); assert.equal(canRunMutation(true, "save").ok, true);
  });

  it("round-trips all nine v2 discriminated parameter families without dropping keys", () => {
    const editor = updateEditorName(createEditorState(literalNineDomainV2Draft as unknown as AdvancedSlaProfileV2), "Nine domains edited");
    const patch = buildAdvancedSlaPatch(editor)!;
    assert.deepEqual(patch.sections.map((section) => section.rules.map((rule) => rule.parameters)), literalNineDomainV2Sections.map((section) => section.rules.map((rule) => rule.parameters)));
  });
});
