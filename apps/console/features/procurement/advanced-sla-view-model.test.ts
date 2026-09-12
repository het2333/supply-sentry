import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ADVANCED_SLA_DOMAIN_LABELS, normalizeAdvancedSlaDashboard, parseAdvancedSlaImportPreview, reconcileAdvancedSlaImportPreview } from "./advanced-sla-view-model";
import { literalNineDomainDraft, literalNineDomainV2Draft } from "./advanced-sla-test-fixtures";

const permissions = { read: true, configure: true, approve: true };
const readiness = { baseSlaPublished: true, communicationIdentityActive: true, emailConnected: true, whatsappConnected: false };
const root = (profiles: unknown[], drafts: unknown[], published: unknown = null) => ({ domains: ADVANCED_SLA_DOMAIN_LABELS.map((id) => ({ id })), profiles, draftProfiles: drafts, publishedProfile: published, runtimeControl: published && typeof published === "object" && "id" in published && "version" in published ? { profileId: published.id, profileVersion: published.version, paused: false, version: 1 } : null, importHistory: [], permissions, readiness, impactPreview: { activePurchaseOrders: 4, matchedPurchaseOrders: 1 }, recentEvents: [] });
const hash = "a".repeat(64);
const preview = {
  id: "advanced-sla-import:batch", profileId: literalNineDomainV2Draft.id, profileVersion: 4, version: 1, status: "previewed", schemaVersion: 2, templateVersion: 2,
  domain: "logistics_planning", sourceName: "planning.csv", sourceSha256: hash, candidateHash: hash, totalCount: 2, validCount: 1, invalidCount: 1, warningCount: 0,
  validationResults: [{ rowNumber: 3, normalizedRuleId: "bad", severity: "error", field: "priority", code: "INVALID_TOO_SMALL", message: "priority must be at least 1" }], validatedAt: "2026-09-03T04:00:00.000Z", createdAt: "2026-09-03T04:00:00.000Z",
  summary: { totalRows: 2, validRows: 1, invalidRows: 1, warnings: 0 },
  impactPreview: { candidateType: "import", candidateId: "advanced-sla-import:batch", candidateVersion: 1, profileId: literalNineDomainV2Draft.id, profileVersion: 4, activePurchaseOrders: 4, matchedPurchaseOrders: 3 },
} as const;

describe("normalizeAdvancedSlaDashboard v2", () => {
  it("keeps canonical nine-domain order and derives v2 status counts", () => {
    const view = normalizeAdvancedSlaDashboard(root([literalNineDomainV2Draft], [literalNineDomainV2Draft]));
    assert.equal(view.state, "draft"); assert.deepEqual(view.domains.map((domain) => domain.id), ADVANCED_SLA_DOMAIN_LABELS); assert.equal(view.domains.every((domain) => domain.enabledRuleCount === 1), true); assert.equal(view.draft?.schemaVersion, 2);
  });

  it("keeps a persisted v1 profile readable with explicit upgrade validation", () => {
    const view = normalizeAdvancedSlaDashboard(root([literalNineDomainDraft], [literalNineDomainDraft]));
    assert.equal(view.state, "draft"); assert.equal(view.draft?.schemaVersion, 1);
    if (view.draft?.schemaVersion !== 1) assert.fail("expected v1 profile");
    assert.equal(view.draft.upgradePreview.ready, false); assert.equal(view.draft.upgradePreview.validationResults[0]?.field, "companyCode");
  });

  it("parses strict per-row v2 validation and reconciles only the exact draft version", () => {
    const parsed = parseAdvancedSlaImportPreview(preview); assert.ok(parsed); assert.equal(parsed.validationResults[0]?.rowNumber, 3); assert.equal(parsed.candidateHash, hash);
    assert.equal(reconcileAdvancedSlaImportPreview(parsed, { id: parsed.profileId, version: parsed.profileVersion }), parsed);
    assert.equal(reconcileAdvancedSlaImportPreview(parsed, { id: parsed.profileId, version: parsed.profileVersion + 1 }), null);
    assert.equal(reconcileAdvancedSlaImportPreview(parsed, { id: parsed.profileId, version: parsed.profileVersion }, true), null);
    assert.equal(parseAdvancedSlaImportPreview({ ...preview, candidateHash: "bad" }), null);
  });

  it("selects exact import candidate impact without overwriting persisted dashboard truth", () => {
    const view = normalizeAdvancedSlaDashboard({ ...root([literalNineDomainV2Draft], [literalNineDomainV2Draft]), importPreview: preview });
    assert.deepEqual(view.impact, preview.impactPreview); assert.equal(view.importHistory.length, 0);
  });

  it("separates published runtime readiness from draft publication readiness", () => {
    const published = { ...literalNineDomainV2Draft, id: "published-v2", status: "published" as const, version: 5, autoSend: { enabled: true, stages: ["po_sent"], channels: ["email"], risks: ["high"] } };
    const draft = { ...literalNineDomainV2Draft, id: "draft-v2", version: 2, autoSend: { enabled: true, stages: ["po_sent"], channels: ["whatsapp"], risks: ["high"] } };
    const view = normalizeAdvancedSlaDashboard(root([draft, published], [draft], published));
    assert.equal(view.publishedRuntime.state, "ready"); assert.equal(view.draftPublication.state, "not_ready");
    assert.equal(normalizeAdvancedSlaDashboard({ ...root([published], [], published), runtimeControl: { profileId: published.id, profileVersion: 5, paused: true, version: 2 } }).publishedRuntime.state, "paused");
  });

  it("normalizes standard v2 upload history fields and fails closed on drift", () => {
    const history = { ...preview, status: "applied", version: 2, appliedBy: "human:manager", appliedAt: "2026-09-03T04:01:00.000Z", updatedAt: "2026-09-03T04:01:00.000Z", createdBy: "human:manager", error: null };
    const view = normalizeAdvancedSlaDashboard({ ...root([literalNineDomainV2Draft], [literalNineDomainV2Draft]), importHistory: [history] });
    assert.equal(view.importHistory[0]?.validCount, 1); assert.equal(view.importHistory[0]?.domain, "logistics_planning");
    assert.equal(normalizeAdvancedSlaDashboard({ ...root([literalNineDomainV2Draft], [literalNineDomainV2Draft]), permissions: { ...permissions, configure: 1 } }).state, "error");
    assert.equal(normalizeAdvancedSlaDashboard(null).state, "error");
  });

  it("rejects contradictory profile collections and cross-schema payloads", () => {
    const published = { ...literalNineDomainV2Draft, id: "published-v2", status: "published" as const, version: 5 };
    assert.equal(normalizeAdvancedSlaDashboard({ ...root([published], [], null), runtimeControl: null }).state, "error");
    assert.equal(normalizeAdvancedSlaDashboard({ ...root([literalNineDomainV2Draft], [literalNineDomainV2Draft]), draftProfiles: [{ ...literalNineDomainV2Draft, schemaVersion: 1 }] }).state, "error");
  });
});
