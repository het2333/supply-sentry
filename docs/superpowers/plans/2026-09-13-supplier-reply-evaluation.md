# Supplier Reply Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a versioned 240-case bilingual supplier-reply benchmark whose deterministic and optional DeepSeek results are generated reproducibly from the same production-shaped parsing contract.

**Architecture:** A strict JSON Schema and checked-in SHA-256 digest define the immutable v1 case contract. A focused evaluation package loads and validates cases, calls either a credential-free deterministic runner or the production structured-output DeepSeek path, scores exact evidence-grounded outputs, and renders machine-readable JSON plus a reviewer-friendly Markdown report. CI reproduces the deterministic summary byte-for-byte; credentialed model reports exist only after successful provider execution.

**Tech Stack:** TypeScript, Node.js 24, JSONL, JSON Schema 2020-12, SHA-256, Pydantic-compatible JSON Schema contracts, DeepSeek structured output, Node test runner

**Spec:** `docs/superpowers/specs/2026-09-13-public-demo-and-portfolio-release-design.md`

## Global Constraints

- Dataset contains exactly 240 `synthetic_contract_case` records and no customer correspondence, real supplier contacts, production identifiers, or real purchase prices.
- Locales cover Chinese, English, mixed-language, and QQ-style formatting.
- Schema rejects unknown properties at every object level.
- Expected extracted values include exact evidence spans; fabricated values are always scored as errors.
- Deterministic runner requires no credentials and is the CI regression gate.
- DeepSeek runner reads `DEEPSEEK_API_KEY` only from process environment and never stores the key or raw provider response.
- Reports record dataset hash, Git commit, runner, model, prompt/schema version, time, tokens, latency, and pricing snapshot when actually available.
- No unavailable latency, token, cost, or model metric may be estimated or filled with a synthetic number.
- Node.js is 24.20.0 and pnpm is 11.7.0.

---

### Task 1: Versioned dataset schema and verifier

**Files:**
- Create: `evals/supplier-replies/v1/dataset.schema.json`
- Create: `evals/supplier-replies/v1/DATASET-CARD.md`
- Create: `evals/supplier-replies/v1/dataset.sha256`
- Create: `packages/evals/src/supplier-replies/types.ts`
- Create: `packages/evals/src/supplier-replies/dataset.ts`
- Create: `packages/evals/test/supplier-reply-dataset.test.ts`
- Modify: `packages/evals/src/index.ts`
- Modify: `packages/evals/package.json`

**Interfaces:**
- Consumes: UTF-8 JSONL input and the v1 JSON Schema.
- Produces: `SupplierReplyCaseV1`, `SupplierReplyExpected`, `EvidenceSpan`, `loadSupplierReplyDataset(path: string): SupplierReplyCaseV1[]`, `verifySupplierReplyDataset(cases, sourceBytes): DatasetVerification`, and `sha256Hex(bytes): string`.

- [ ] **Step 1: Define the strict TypeScript record contract**

```ts
export type SupplierReplyLocale = 'zh-CN' | 'en-US' | 'mixed' | 'qq-mail';
export type ExpectedAssociation = 'matched' | 'ambiguous' | 'unmatched';
export type ExpectedValidation = 'accepted' | 'review_required' | 'rejected';

export interface EvidenceSpan {
  field: 'deliveryDate' | 'quantity' | 'unitPrice' | 'currency' | 'productionStatus' | 'shipmentStatus' | 'trackingNumber' | 'eta';
  start: number;
  end: number;
  text: string;
}

export interface SupplierReplyCaseV1 {
  caseId: string;
  datasetVersion: 'supplier-replies-v1';
  provenance: 'synthetic_contract_case';
  locale: SupplierReplyLocale;
  scenarioTags: string[];
  difficulty: 'basic' | 'intermediate' | 'adversarial';
  adversarialFlags: string[];
  receivedAt: string;
  body: string;
  candidates: { supplierId: string; poId: string; supplierName: string; poNumber: string }[];
  expected: SupplierReplyExpected;
}
```

- [ ] **Step 2: Write verifier tests**

Cover duplicate IDs, extra JSON properties, non-reserved email domains, secret-shaped strings, invalid dates, mismatched evidence text/offsets, missing unknown-field labels, impossible association labels, absent class coverage, fewer/more than 240 records, and digest mismatch.

```ts
test('evidence spans point to the exact source substring', () => {
  const value = validCase();
  value.expected.evidence[0] = { field: 'quantity', start: 0, end: 2, text: '999' };
  assert.throws(() => verifySupplierReplyDataset([value], encode([value])), /evidence span/i);
});
```

- [ ] **Step 3: Run the verifier tests and confirm the module is absent**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test packages/evals/test/supplier-reply-dataset.test.ts`

Expected: FAIL because the supplier-reply dataset module does not exist.

- [ ] **Step 4: Implement parsing and semantic verification**

Validate JSONL line numbers, exact allowed keys, RFC 3339 timestamps, unique stable IDs matching `sr-v1-NNN`, exact evidence offsets, reserved domains (`example.com`, `example.net`, `example.org`, `example.test`), forbidden key/secret patterns, tag/label consistency, and minimum coverage counts from `DATASET-CARD.md`. Compute the digest over exact checked-in `dataset.jsonl` bytes.

- [ ] **Step 5: Write the dataset card with explicit provenance and limitations**

Document generation method, intended use, non-customer synthetic provenance, languages, label definitions, class distribution, known limits, privacy scan, versioning rule, and the distinction between real execution and synthetic cases.

- [ ] **Step 6: Run unit tests**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test packages/evals/test/supplier-reply-dataset.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the dataset contract**

```bash
git add evals/supplier-replies/v1/dataset.schema.json evals/supplier-replies/v1/DATASET-CARD.md packages/evals/src/supplier-replies/types.ts packages/evals/src/supplier-replies/dataset.ts packages/evals/src/index.ts packages/evals/package.json packages/evals/test/supplier-reply-dataset.test.ts
git commit -m "test: define supplier reply evaluation contract"
```

### Task 2: Construct and validate all 240 labeled cases

**Files:**
- Create: `evals/supplier-replies/v1/dataset.jsonl`
- Create: `scripts/evals/generate-supplier-reply-dataset.ts`
- Create: `scripts/evals/verify-supplier-reply-dataset.ts`
- Create: `scripts/evals/test/generate-supplier-reply-dataset.test.ts`
- Modify: `evals/supplier-replies/v1/dataset.sha256`
- Modify: `evals/supplier-replies/v1/DATASET-CARD.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: the v1 contract and deterministic scenario templates with fixed seed `0x53555050`.
- Produces: exactly 240 stable JSONL rows, a digest, `pnpm eval:supplier-replies:verify`, and documented class counts.

- [ ] **Step 1: Write generation determinism and distribution tests**

Assert two runs are byte-identical and these primary buckets contain 30 cases each: exact date, relative/vague date, quantity/partial shipment, price/currency variance, production/shipment/transport, quoted-history contamination, wrong/ambiguous association, and missing/contradictory facts. Cross-cut locale and difficulty so each locale has 60 cases and adversarial cases total at least 60.

- [ ] **Step 2: Run generator tests and verify they fail**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test scripts/evals/test/generate-supplier-reply-dataset.test.ts`

Expected: FAIL because the generator is absent.

- [ ] **Step 3: Implement deterministic scenario builders**

Each builder must calculate evidence positions from the final rendered body using `body.indexOf(evidenceText)` and reject missing or non-unique spans. Dates resolve from each record's fixed `receivedAt`, not system time. Names and contacts come only from a fixed fictional catalog using reserved domains.

- [ ] **Step 4: Generate the checked-in dataset and digest**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx scripts/evals/generate-supplier-reply-dataset.ts --write`

Expected: writes 240 JSONL rows and updates `dataset.sha256`; output prints exact locale, difficulty, association, review, and scenario distributions.

- [ ] **Step 5: Verify the generated artifact independently**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies:verify`

Expected: prints `cases=240`, the committed SHA-256, `privacy=pass`, `schema=pass`, `labels=pass`.

- [ ] **Step 6: Run secret and contact scans**

Run: `rg -n '(sk-[A-Za-z0-9]{16,}|@qq\.com|@163\.com|@126\.com|@[A-Za-z0-9.-]+\.(cn|com))' evals/supplier-replies/v1/dataset.jsonl | rg -v '@example\.(com|net|org)|@example\.test'`

Expected: no output.

- [ ] **Step 7: Commit dataset v1**

```bash
git add evals/supplier-replies/v1/dataset.jsonl evals/supplier-replies/v1/dataset.sha256 evals/supplier-replies/v1/DATASET-CARD.md scripts/evals/generate-supplier-reply-dataset.ts scripts/evals/verify-supplier-reply-dataset.ts scripts/evals/test/generate-supplier-reply-dataset.test.ts package.json
git commit -m "test: add 240 supplier reply benchmark cases"
```

### Task 3: Shared runner contract and deterministic baseline

**Files:**
- Create: `packages/evals/src/supplier-replies/runner.ts`
- Create: `packages/evals/src/supplier-replies/deterministic-runner.ts`
- Create: `packages/evals/test/supplier-reply-deterministic-runner.test.ts`
- Modify: `packages/evals/src/index.ts`
- Modify: `apps/api/src/procurement-ai-reply.ts`

**Interfaces:**
- Consumes: `SupplierReplyCaseV1` and production-shaped structured proposal validation.
- Produces: `SupplierReplyPrediction`, `SupplierReplyRunMetadata`, `SupplierReplyRunner.run(case): Promise<SupplierReplyCaseResult>`, `createDeterministicSupplierReplyRunner()`, and shared `validateSupplierReplyProposal(value, context)`.

- [ ] **Step 1: Extract the production proposal validator without changing behavior**

Move pure schema/evidence/date/association validation from `procurement-ai-reply.ts` behind this interface:

```ts
export interface SupplierReplyRunner {
  readonly id: 'deterministic' | 'deepseek';
  readonly model: string;
  readonly promptVersion: string;
  readonly schemaVersion: 'supplier-reply-proposal-v1';
  run(input: SupplierReplyRunnerInput): Promise<SupplierReplyRunnerOutput>;
}
```

- [ ] **Step 2: Write deterministic runner tests**

Cover exact Chinese and English dates, relative date resolution, vague-date review, partial quantity, currency variance, quoted history exclusion, wrong PO, ambiguous candidates, contradictions, missing facts, and no-fabrication output.

- [ ] **Step 3: Run tests and confirm runner is missing**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test packages/evals/test/supplier-reply-deterministic-runner.test.ts apps/api/test/procurement-ai-reply.test.ts`

Expected: FAIL because the new runner and shared validator do not exist.

- [ ] **Step 4: Implement the deterministic baseline**

Use explicit patterns, candidate context, and evidence offsets. Unsupported/vague facts become `unknownFields` and `review_required`; the runner must never infer an exact date or quantity that is absent from the message. Return zero token/cost fields as `null`, not numeric zero, because no model call occurred.

- [ ] **Step 5: Run focused tests and the full 240-case dataset**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test packages/evals/test/supplier-reply-deterministic-runner.test.ts apps/api/test/procurement-ai-reply.test.ts`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies -- --runner deterministic --report-dir /tmp/supplysentry-eval-check`

Expected: 240 cases execute; no case crashes; report declares runner `deterministic` and dataset hash matches the committed digest.

- [ ] **Step 6: Commit shared validation and deterministic runner**

```bash
git add packages/evals/src/supplier-replies/runner.ts packages/evals/src/supplier-replies/deterministic-runner.ts packages/evals/src/index.ts packages/evals/test/supplier-reply-deterministic-runner.test.ts apps/api/src/procurement-ai-reply.ts apps/api/test/procurement-ai-reply.test.ts
git commit -m "feat: add deterministic supplier reply runner"
```

### Task 4: Exact scoring and reproducible reports

**Files:**
- Create: `packages/evals/src/supplier-replies/scoring.ts`
- Create: `packages/evals/src/supplier-replies/report.ts`
- Create: `packages/evals/test/supplier-reply-scoring.test.ts`
- Create: `apps/evals/src/supplier-replies.ts`
- Create: `evals/supplier-replies/v1/expected-summary.json`
- Create: `reports/evaluations/supplier-replies-v1.json`
- Create: `reports/evaluations/supplier-replies-v1.md`
- Modify: `apps/evals/src/index.ts`
- Modify: `apps/evals/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: dataset cases and runner outputs.
- Produces: `scoreSupplierReplyCases(results): SupplierReplyMetrics`, `renderSupplierReplyMarkdown(report): string`, JSON report schema, `pnpm eval:supplier-replies`, and `pnpm eval:supplier-replies:check`.

- [ ] **Step 1: Write metric unit tests with hand-calculated examples**

Define TP/FP/FN at normalized field-value level. Association accuracy is exact label plus matched PO when applicable. Missing-fact recall counts expected unknown fields identified. Fabrication rate is fabricated predicted facts divided by all predicted facts. Accepted-result rate requires correct association, valid evidence, correct approval decision, and no fabrication.

```ts
assert.deepEqual(scoreField([{ expected: ['10'], predicted: ['10', '12'] }]), {
  truePositive: 1, falsePositive: 1, falseNegative: 0,
  precision: 0.5, recall: 1, f1: 2 / 3,
});
```

- [ ] **Step 2: Run scoring tests and verify failures**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test packages/evals/test/supplier-reply-scoring.test.ts`

Expected: FAIL because scoring/report modules are missing.

- [ ] **Step 3: Implement metrics, metadata, and stable serialization**

Sort object keys and case results deterministically. Store `generatedAt` only in the full report; exclude it from `expected-summary.json` so CI diff is stable. Include per-tag slices and all specified aggregate metrics. Latency uses measured per-case wall time; token/cost summaries are `null` when runner metadata lacks actual usage.

- [ ] **Step 4: Implement CLI and Markdown rendering**

Support `--runner deterministic|deepseek`, `--dataset`, `--report-dir`, `--check`, and `--concurrency`. Redact errors, omit raw provider response, and exit nonzero on schema failure, case crash, dataset digest mismatch, or expected-summary diff.

- [ ] **Step 5: Generate deterministic reports from actual execution**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies -- --runner deterministic --write-expected`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies:check`

Expected: report has exactly 240 case results; the second command reproduces the committed summary without a diff.

- [ ] **Step 6: Commit scorer and generated baseline**

```bash
git add packages/evals/src/supplier-replies/scoring.ts packages/evals/src/supplier-replies/report.ts packages/evals/test/supplier-reply-scoring.test.ts apps/evals/src/supplier-replies.ts apps/evals/src/index.ts apps/evals/package.json package.json evals/supplier-replies/v1/expected-summary.json reports/evaluations/supplier-replies-v1.json reports/evaluations/supplier-replies-v1.md
git commit -m "feat: publish reproducible supplier reply evaluation"
```

### Task 5: Optional real DeepSeek structured-output runner

**Files:**
- Create: `packages/evals/src/supplier-replies/deepseek-runner.ts`
- Create: `packages/evals/test/supplier-reply-deepseek-runner.test.ts`
- Create: `scripts/evals/run-deepseek-supplier-replies.sh`
- Modify: `packages/evals/src/index.ts`
- Modify: `apps/evals/src/supplier-replies.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` defaulting to the documented API URL, shared production proposal schema, and `SupplierReplyRunner`.
- Produces: `createDeepSeekSupplierReplyRunner(config): SupplierReplyRunner`, actual usage/latency metadata, and a local credentialed report directory ignored by Git unless explicitly reviewed for publication.

- [ ] **Step 1: Write HTTP-stub tests**

Assert structured response request, bounded timeout, retry only for 429/5xx transport failures, schema retry after invalid structured output, no retry for authentication errors, sanitized error text, recorded actual token usage, and absence of API keys/raw provider responses in outputs.

- [ ] **Step 2: Run runner tests and verify the module is absent**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test packages/evals/test/supplier-reply-deepseek-runner.test.ts`

Expected: FAIL because the DeepSeek runner does not exist.

- [ ] **Step 3: Implement the production-shaped runner**

Use a supplied `fetch` for tests, read the environment key only in the CLI factory, request JSON structured output, validate through `validateSupplierReplyProposal`, retain only normalized prediction and aggregate usage, and hash the prompt/schema version. Never serialize request headers or raw response content.

- [ ] **Step 4: Run stub tests**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm exec tsx --test packages/evals/test/supplier-reply-deepseek-runner.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the real provider only when a key is already present**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" ./scripts/evals/run-deepseek-supplier-replies.sh`

Expected with provider access: 240 cases complete and a report records actual model, tokens, latency, and calculated price snapshot. Expected without provider access: exit 2 with `DeepSeek evaluation unavailable: DEEPSEEK_API_KEY is not set`; no report is created.

- [ ] **Step 6: Scan the report before opting it into Git**

Run: `rg -n '(sk-[A-Za-z0-9]{16,}|authorization|rawResponse|api[_-]?key)' reports/evaluations/deepseek-local`

Expected: no output. Move a reviewed report into `reports/evaluations/` only after a complete successful run; otherwise README reports the model evaluation as unavailable.

- [ ] **Step 7: Commit the optional runner without local credentialed artifacts**

```bash
git add packages/evals/src/supplier-replies/deepseek-runner.ts packages/evals/src/index.ts packages/evals/test/supplier-reply-deepseek-runner.test.ts apps/evals/src/supplier-replies.ts scripts/evals/run-deepseek-supplier-replies.sh .gitignore
git commit -m "feat: add optional DeepSeek evaluation runner"
```

### Task 6: Evaluation CI gate and published evidence

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/demo-image.yml`
- Modify: `reports/evaluations/supplier-replies-v1.md`

**Interfaces:**
- Consumes: `pnpm eval:supplier-replies:verify` and `pnpm eval:supplier-replies:check`.
- Produces: required CI checks `supplier-reply-dataset` and `supplier-reply-evaluation`, plus a manual DeepSeek workflow artifact.

- [ ] **Step 1: Add deterministic checks to pull requests and main**

Run dataset verification before evaluation. Regenerate the deterministic summary into a temporary directory and compare it byte-for-byte with `expected-summary.json`; upload full reports as CI artifacts on failure for diagnosis.

- [ ] **Step 2: Add manual credentialed evaluation**

Use `workflow_dispatch`, repository secret `DEEPSEEK_API_KEY`, concurrency 1, no pull-request trigger, and artifact retention. The job must label output as unpublished until a maintainer reviews and commits it.

- [ ] **Step 3: Verify workflow syntax and local parity**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies:verify && PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies:check`

Expected: both commands exit 0 with the same dataset digest.

- [ ] **Step 4: Commit evaluation CI**

```bash
git add .github/workflows/ci.yml .github/workflows/demo-image.yml reports/evaluations/supplier-replies-v1.md
git commit -m "ci: gate supplier reply evaluation regressions"
```
