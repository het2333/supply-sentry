# Public Portfolio Release Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Coordinate the runtime, evaluation, architecture, media, README, deployment, and GitHub release plans into one dependency-safe delivery sequence with evidence gates.

**Architecture:** Three implementation plans produce independently reviewable deliverables: the isolated full-stack demo, the reproducible supplier-reply benchmark, and the portfolio presentation assets. This orchestration plan permits runtime and evaluation implementation to proceed independently, but deployment precedes media capture, and all verified artifacts precede README claims and the final release.

**Tech Stack:** Git, Node.js 24, pnpm 11.7.0, Docker Compose, GitHub Actions, GHCR, GitHub Releases

**Spec:** `docs/superpowers/specs/2026-09-13-public-demo-and-portfolio-release-design.md`

## Global Constraints

- Execute detailed steps from the three named implementation plans; this file controls ordering and release gates.
- Work on the existing `main` checkout without discarding or overwriting unrelated user changes.
- Each component commit must pass its focused RED/GREEN tests before the next component depends on it.
- Do not expose port 3002 until local isolation, seed, denial, side-effect, reset, and health checks pass.
- Do not capture media until the deployed demo is externally verified and contains only synthetic data.
- Do not publish README URLs, badges, metrics, or release claims until their targets and values are verified.
- Node commands use `/Users/etheralia/.nvm/versions/node/v24.20.0/bin` first in `PATH`.
- No credential, email authorization code, API key, cookie, production database, Hermes session, or customer record enters Git, image layers, reports, logs, media, or the public demo.

---

### Task 1: Freeze the planning baseline

**Files:**
- Verify: `docs/superpowers/specs/2026-09-13-public-demo-and-portfolio-release-design.md`
- Verify: `docs/superpowers/plans/2026-09-13-public-demo-runtime-and-deployment.md`
- Verify: `docs/superpowers/plans/2026-09-13-supplier-reply-evaluation.md`
- Verify: `docs/superpowers/plans/2026-09-13-portfolio-assets-readme-release.md`
- Verify: `docs/superpowers/plans/2026-09-13-public-release-execution-order.md`

**Interfaces:**
- Consumes: approved design `edb6a15`.
- Produces: one committed planning baseline and explicit dependency map.

- [ ] **Step 1: Scan every plan for incomplete instructions**

Run: `blocked='TB''D|TO''DO|implement la''ter|fill in de''tails|similar to ta''sk|add appro''priate|handle edge ca''ses|write tests for the ab''ove'; rg -n "$blocked" docs/superpowers/plans/2026-09-13-*.md`

Expected: no output.

- [ ] **Step 2: Verify shared names and constants**

Run: `rg -n 'READYWORK_PUBLIC_DEMO|t:public-demo|simulated_demo|supplier-replies-v1|47\.102\.116\.148:3002|24\.20\.0|11\.7\.0' docs/superpowers/specs/2026-09-13-public-demo-and-portfolio-release-design.md docs/superpowers/plans/2026-09-13-*.md`

Expected: the same spelling and values are used throughout; no competing public-demo tenant, port, runner, or seed name exists.

- [ ] **Step 3: Commit all implementation plans**

```bash
git add docs/superpowers/plans/2026-09-13-public-demo-runtime-and-deployment.md docs/superpowers/plans/2026-09-13-supplier-reply-evaluation.md docs/superpowers/plans/2026-09-13-portfolio-assets-readme-release.md docs/superpowers/plans/2026-09-13-public-release-execution-order.md
git commit -m "docs: plan public demo portfolio release"
```

### Task 2: Implement the isolated public-demo runtime

**Files:**
- Follow: `docs/superpowers/plans/2026-09-13-public-demo-runtime-and-deployment.md`

**Interfaces:**
- Consumes: approved design and planning baseline.
- Produces: public-demo identity, seed/reset, simulated receipts, console UX, Docker stack, CI/GHCR, and local acceptance evidence.

- [ ] **Step 1: Execute runtime plan Tasks 1–6 in order**

Use each task's focused test command and commit boundary. Do not begin server deployment while any connector spy records a call or any demo Compose mount references `/opt/readywork/shared`.

- [ ] **Step 2: Run the local runtime gate**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node --test infra/demo/test/*.test.mjs && PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node scripts/demo/verify-public-demo.mjs --base-url http://127.0.0.1:3002`

Expected: contract and acceptance checks PASS, status is public-demo mode, all mutations stay in `t:public-demo`, and all side effects are `simulated_demo`.

- [ ] **Step 3: Execute runtime plan Task 7 through local CI/GHCR configuration**

Commit workflow and deployment automation; do not run the remote deployment step until Task 4 of this orchestration plan passes.

### Task 3: Implement and freeze the reproducible evaluation

**Files:**
- Follow: `docs/superpowers/plans/2026-09-13-supplier-reply-evaluation.md`

**Interfaces:**
- Consumes: shared supplier-reply proposal validation.
- Produces: verified 240-case dataset, deterministic report, optional DeepSeek runner, and CI regression gate.

- [ ] **Step 1: Execute evaluation plan Tasks 1–4**

Preserve each focused test and commit boundary. The dataset must validate before any reported metric is accepted.

- [ ] **Step 2: Run deterministic reproduction twice**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies:check && PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies:check`

Expected: both runs return the same dataset hash and expected summary with 240 completed cases.

- [ ] **Step 3: Execute evaluation plan Tasks 5–6**

Add the optional DeepSeek runner and CI gate. Publish a DeepSeek report only if all 240 real provider calls complete and the report passes the secret scan; otherwise record that model evaluation is not published.

### Task 4: Run the pre-deployment release gate

**Files:**
- Verify: all tracked source, tests, demo infrastructure, evaluation artifacts, and workflows.

**Interfaces:**
- Consumes: runtime and evaluation outputs.
- Produces: exact releasable commit with no known local regression or public-data leak.

- [ ] **Step 1: Run type, test, localization, deployment, evaluation, and build checks**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm typecheck`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm test`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm test:localization && PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm test:deploy:contracts`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies:verify && PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies:check`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" READYWORK_PUBLIC_DEMO=1 pnpm --filter @readywork/app-console build`

Expected: every command exits 0.

- [ ] **Step 2: Run current-file and history secret scans**

Run: `git grep -nE '(sk-[A-Za-z0-9]{16,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|xox[baprs]-[A-Za-z0-9-]+)' -- . ':!pnpm-lock.yaml'`

Run: `git log -p --all | rg -n '(sk-[A-Za-z0-9]{16,}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|xox[baprs]-[A-Za-z0-9-]+)'`

Expected: no true secret finding. Stop publication if a credential value is found.

- [ ] **Step 3: Review the exact diff and commit graph**

Run: `git status --short && git diff --check && git log --oneline --decorate -15`

Expected: no unstaged release file, no whitespace error, and every plan task has an intelligible commit.

### Task 5: Publish the image and deploy the isolated online demo

**Files:**
- Follow: runtime plan Task 7.
- Update: `reports/demo/public-demo-acceptance.md`

**Interfaces:**
- Consumes: passing release gate and GHCR SHA image.
- Produces: externally verified `http://47.102.116.148:3002` and deployment evidence.

- [ ] **Step 1: Push through GitHub checks and resolve the immutable image digest**

Run: `git push origin main`

Expected: mandatory checks pass and GHCR publishes the exact commit SHA image. Record the digest, not a mutable tag alone.

- [ ] **Step 2: Deploy with the isolated server script**

Run: `./scripts/demo/deploy-server.sh admin@47.102.116.148`

Expected: only `/opt/supplysentry-demo`, project `supplysentry-demo`, its dedicated volumes, and port 3002 are touched.

- [ ] **Step 3: Run external acceptance**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node scripts/demo/verify-public-demo.mjs --base-url http://47.102.116.148:3002`

Expected: login, mutation, approval, projection, notification, audit, simulation, denial, and reset assertions PASS.

- [ ] **Step 4: Commit redacted deployment evidence**

```bash
git add reports/demo/public-demo-acceptance.md
git commit -m "docs: verify online public demo"
```

### Task 6: Produce architecture and demo media from the verified environment

**Files:**
- Follow: `docs/superpowers/plans/2026-09-13-portfolio-assets-readme-release.md` Tasks 1–3.

**Interfaces:**
- Consumes: verified online demo and stable seeded generation.
- Produces: Draw.io/SVG architecture, GIF, poster, MP4, capture tooling, and media acceptance evidence.

- [ ] **Step 1: Execute architecture plan Task 1**

Run its contract, export, accessibility, and visual checks before committing.

- [ ] **Step 2: Execute media plan Tasks 2–3**

Capture only public-demo data. Reject and recapture any artifact that shows browser chrome, a real contact, production URL, credential, desktop notification, missing simulation banner, unreadable pointer, broken transition, or clipped content.

- [ ] **Step 3: Verify repository media size**

Run: `find docs/assets -type f -size +8M -print`

Expected: no output. The MP4 remains ignored and is uploaded only as a release asset.

### Task 7: Publish README and the portfolio release

**Files:**
- Follow: portfolio plan Tasks 4–5.

**Interfaces:**
- Consumes: externally verified demo, immutable image digest, measured report, architecture assets, media assets, and validation output.
- Produces: bilingual public landing page, GitHub Release, MP4 asset, and verified final links.

- [ ] **Step 1: Execute README plan Task 4 without unverified claims**

Run the README contract/link verifier and inspect desktop plus narrow layouts before committing.

- [ ] **Step 2: Execute release plan Task 5**

Wait for required checks, create the versioned release, upload the MP4, add immutable links, rerun the external README verifier, commit, and push.

- [ ] **Step 3: Run final public acceptance from a clean checkout**

Run: `tmp_dir="$(mktemp -d)"; git clone https://github.com/het2333/supply-sentry.git "$tmp_dir/supply-sentry" && cd "$tmp_dir/supply-sentry" && ./scripts/demo/demo.sh up`

Expected: anonymous clone succeeds, the one-command demo becomes healthy, and the browser opens a synthetic public workspace without a private credential.

- [ ] **Step 4: Record final release evidence**

Run: `gh release view v1.0.0-portfolio --repo het2333/supply-sentry`

Run: `git status --short --branch`

Expected: release and MP4 asset are public, README links pass, local tree is clean, and `main` matches `origin/main`.
