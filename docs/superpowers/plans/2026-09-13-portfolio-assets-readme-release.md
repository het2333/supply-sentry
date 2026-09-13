# Portfolio Assets, README, and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the public repository landing page into a verifiable bilingual portfolio release with an editable architecture diagram, compact demo GIF, full walkthrough video release asset, online demo link, Docker quick start, and measured evaluation evidence.

**Architecture:** Draw.io is the authoritative architecture source and exports a selectable-text SVG for README display. A deterministic Playwright capture script drives the isolated seeded demo at 1440×900, producing a privacy-safe poster, GIF, and 60–90 second MP4 through reproducible media commands. The English README leads, links a complete Chinese README, and surfaces only verified URLs, image tags, metrics, and release assets.

**Tech Stack:** Draw.io XML/SVG, Playwright, Chromium, ffmpeg, gifski, Markdown, GitHub Releases, Node.js 24

**Spec:** `docs/superpowers/specs/2026-09-13-public-demo-and-portfolio-release-design.md`

## Global Constraints

- Architecture diagram contains Human/channels, trusted SupplySentry runtime, and external/side-effect boundaries.
- Diagram labels `Model proposes; business runtime decides` and visually separates decision data from side-effect commands.
- README GIF is 15–20 seconds, 1440×900 capture source, below 8 MB, silent, and visibly labeled as synthetic/simulated.
- Walkthrough video is 60–90 seconds, 1080p H.264, contains concise bilingual-safe captions, and is a GitHub Release asset rather than a tracked Git blob.
- Captures contain no production URLs, user accounts, browser chrome/bookmarks, desktop notifications, credentials, or real contacts.
- README never claims an online demo, GHCR image, model metric, or video URL before that resource has been externally verified.
- English `README.md` is the landing page and links `README.zh-CN.md`.
- Implemented behavior, roadmap work, deterministic evaluation, model evaluation, synthetic data, and simulated receipts are labeled distinctly.
- Node.js is 24.20.0 and pnpm is 11.7.0.

---

### Task 1: Editable architecture source and accessible SVG

**Files:**
- Create: `docs/architecture/supplysentry-architecture.drawio`
- Create: `docs/architecture/supplysentry-architecture.md`
- Create: `docs/assets/supplysentry-architecture.svg`
- Create: `scripts/docs/verify-architecture.mjs`
- Create: `scripts/docs/test/architecture-contract.test.mjs`

**Interfaces:**
- Consumes: approved system flow and public-demo boundary from the design spec.
- Produces: authoritative Draw.io XML, generated SVG, and `node scripts/docs/verify-architecture.mjs`.

- [ ] **Step 1: Use the `drawio-skill` before creating the diagram**

Read its complete instructions, follow its draw.io source workflow, and preserve an editable `.drawio` file rather than hand-authoring only an SVG.

- [ ] **Step 2: Write architecture contract tests**

Assert both source and SVG contain the three boundary labels, every main-flow node, `Model proposes; business runtime decides`, `simulated_demo`, and no raster `<image>` dependencies. Assert SVG has a `viewBox`, readable title/description, selectable `<text>` or equivalent accessible labels, and no width over 1600 CSS pixels.

- [ ] **Step 3: Run tests and verify artifacts are absent**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node --test scripts/docs/test/architecture-contract.test.mjs`

Expected: FAIL because the architecture artifacts are missing.

- [ ] **Step 4: Build the diagram with explicit flows**

The central sequence is `Console / Inbox → Business & Control APIs → Temporal Workflow → Manufacturing Context Snapshot → DeepSeek Structured Proposal → Schema & Evidence Validation → Human Approval → Action Gateway → Inbox / Outbox → External Systems → Receipt → SQLite Facts / Projection / SLA / Risk / Audit`. Use solid arrows for commands, dashed arrows for decision/context data, and a visually distinct public-demo interception path ending in `simulated_demo`.

- [ ] **Step 5: Export and verify the SVG**

Run: `drawio --export --format svg --embed-svg-images --output docs/assets/supplysentry-architecture.svg docs/architecture/supplysentry-architecture.drawio`

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node scripts/docs/verify-architecture.mjs`

Expected: verifier reports all required labels, accessible title/description, no external image links, and contrast-safe palette tokens.

- [ ] **Step 6: Visually inspect light, dark, and narrow renders**

Render SVG at 1200 px and 640 px width on light and dark backgrounds. Verify labels remain readable, arrows do not cross text, group boundaries remain distinct, and no horizontal scrolling is required.

- [ ] **Step 7: Commit architecture artifacts**

```bash
git add docs/architecture/supplysentry-architecture.drawio docs/architecture/supplysentry-architecture.md docs/assets/supplysentry-architecture.svg scripts/docs/verify-architecture.mjs scripts/docs/test/architecture-contract.test.mjs
git commit -m "docs: add SupplySentry architecture diagram"
```

### Task 2: Deterministic capture driver and privacy gates

**Files:**
- Create: `scripts/demo/capture-public-demo.mjs`
- Create: `scripts/demo/capture-story.json`
- Create: `scripts/demo/verify-public-demo-media.mjs`
- Create: `scripts/demo/test/capture-public-demo.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: verified public demo base URL, fixed seed generation, public session endpoint, stable data-testid selectors, Playwright Chromium.
- Produces: `artifacts/media/supplysentry-demo/source.webm`, `poster.png`, `capture-manifest.json`, and deterministic capture command `pnpm demo:capture`.

- [ ] **Step 1: Write capture manifest and privacy contract tests**

Assert viewport 1440×900, no browser chrome, exact approved route sequence, expected demo banner in every scene, maximum scene durations, public-demo tenant only, and forbidden host/contact/credential patterns absent from story data and manifests.

- [ ] **Step 2: Run tests and verify the capture driver is absent**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node --test scripts/demo/test/capture-public-demo.test.mjs`

Expected: FAIL because capture files do not exist.

- [ ] **Step 3: Add stable UI selectors required by the story**

Use existing visible labels when stable; add `data-testid` only to the public entry, demo banner, risk-order row, supplier evidence panel, approval CTA, projection state, notification row, audit event, supplier directory, SLA, Inbox, and Outbox. Do not encode database UUIDs into selectors.

- [ ] **Step 4: Implement the capture sequence**

The primary five scenes are: enter public demo; open risk order; inspect supplier reply/evidence; approve short delivery; show updated projection, notification, and audit. Extended video scenes add supplier directory, SLA, Inbox/Outbox, and architecture summary. Freeze animation-sensitive timestamps through the demo seed/reset endpoint and record only the application viewport.

- [ ] **Step 5: Run capture against the local clean demo**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" READYWORK_DEMO_BASE_URL=http://127.0.0.1:3002 pnpm demo:capture`

Expected: all selectors resolve, story actions succeed, source WebM and poster exist, and manifest records only public-demo identifiers.

- [ ] **Step 6: Run privacy verifier**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node scripts/demo/verify-public-demo-media.mjs artifacts/media/supplysentry-demo`

Expected: duration, resolution, hostname, text/OCR, metadata, and file inventory checks PASS; no production identifier or real contact is found.

- [ ] **Step 7: Commit capture tooling only**

```bash
git add scripts/demo/capture-public-demo.mjs scripts/demo/capture-story.json scripts/demo/verify-public-demo-media.mjs scripts/demo/test/capture-public-demo.test.mjs package.json .gitignore apps/console
git commit -m "test: add deterministic public demo capture"
```

### Task 3: Generate README GIF, poster, and complete walkthrough video

**Files:**
- Create: `docs/assets/supplysentry-demo.gif`
- Create: `docs/assets/supplysentry-demo-poster.webp`
- Create: `artifacts/media/supplysentry-demo/supplysentry-walkthrough.mp4` (release asset; ignored by Git)
- Create: `scripts/demo/render-public-demo-media.sh`
- Create: `reports/demo/media-acceptance.md`

**Interfaces:**
- Consumes: verified `source.webm`, poster PNG, capture manifest, ffmpeg, and gifski.
- Produces: checked-in GIF/poster, ignored 1080p H.264 MP4, SHA-256 values, and media acceptance report.

- [ ] **Step 1: Implement deterministic media rendering**

Use ffmpeg to create a 1920×1080 H.264 MP4 with `yuv420p`, faststart, stripped metadata, and 60–90 second duration. Cut the approved 15–20 second primary story for GIF conversion at a readable frame rate; use a generated palette or gifski and enforce the 8 MB limit. Convert the clean poster to WebP.

- [ ] **Step 2: Render the three deliverables**

Run: `./scripts/demo/render-public-demo-media.sh artifacts/media/supplysentry-demo/source.webm`

Expected: GIF is 15–20 seconds and below 8 MB; MP4 is 60–90 seconds, 1920×1080, H.264, `yuv420p`; poster is WebP and visually matches the opening state.

- [ ] **Step 3: Verify technical media properties**

Run: `ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height,pix_fmt -of json docs/assets/supplysentry-demo.gif artifacts/media/supplysentry-demo/supplysentry-walkthrough.mp4`

Expected: properties match the approved ranges; metadata contains no local paths or user names.

- [ ] **Step 4: Visually inspect the full GIF and MP4**

Check first frame, every transition, approval click, resulting projection, final frame, captions, pointer visibility, text legibility, demo banner persistence, and absence of personal or production content. Record pass/fail for each item in `reports/demo/media-acceptance.md` with file hashes.

- [ ] **Step 5: Commit only repository-sized assets and evidence**

```bash
git add docs/assets/supplysentry-demo.gif docs/assets/supplysentry-demo-poster.webp scripts/demo/render-public-demo-media.sh reports/demo/media-acceptance.md
git commit -m "docs: add verified SupplySentry demo media"
```

### Task 4: Rewrite the English and Chinese repository landing pages

**Files:**
- Modify: `README.md`
- Create: `README.zh-CN.md`
- Create: `scripts/docs/verify-readme.mjs`
- Create: `scripts/docs/test/readme-contract.test.mjs`

**Interfaces:**
- Consumes: verified demo URL, Docker command, deterministic evaluation report, architecture SVG, GIF/poster, release URL, GHCR image tag, validation totals.
- Produces: English landing README, complete Chinese README, link/status verifier, and README contract tests.

- [ ] **Step 1: Write README structure and truthfulness tests**

Assert the first screen has name/positioning, build/tests/license/Docker/demo badges, inline GIF with poster fallback, Try Online and Run Locally CTAs, and three proof points. Assert later sections exist in this order: Product workflow, Measured evaluation, Architecture, Quick start, Engineering decisions, Security boundaries, Repository structure, Validation, Roadmap, License.

- [ ] **Step 2: Run README contract tests and verify the current landing page fails**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node --test scripts/docs/test/readme-contract.test.mjs`

Expected: FAIL on missing media, evaluation, architecture, or verified release sections.

- [ ] **Step 3: Rewrite `README.md` as the English landing page**

Lead with `SupplySentry | Evidence-driven procurement execution agent`. Show the business loop `supplier reply → structured evidence → policy validation → human approval → controlled action → durable projection`. Explain LangGraph/Temporal-style state, tools, evaluation, and engineering decisions by their actual responsibility rather than as a technology list.

- [ ] **Step 4: Add a complete Chinese README**

Mirror the verified facts and links but write natural Chinese rather than sentence-by-sentence machine translation. Keep commands, metric values, image hashes, and boundary statements identical across languages.

- [ ] **Step 5: Populate only measured evidence**

Read evaluation numbers directly from `reports/evaluations/supplier-replies-v1.json`; read validation totals from current test output; link the online URL only after external verification; link the MP4 only after GitHub Release publication. If DeepSeek evaluation is unavailable, state `DeepSeek evaluation: not published` rather than showing an estimate.

- [ ] **Step 6: Run README verification**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" node scripts/docs/verify-readme.mjs`

Expected: all local assets exist, Markdown links resolve, English/Chinese facts match, metrics equal report JSON, demo endpoint is public-demo mode, GHCR manifest resolves, and release asset returns success.

- [ ] **Step 7: Inspect desktop and narrow README renders**

Verify the GIF/poster and architecture fit at GitHub desktop width and 640 px width, tables do not force horizontal scrolling, calls to action remain above the fold, and badges do not imply unverified status.

- [ ] **Step 8: Commit bilingual landing pages**

```bash
git add README.md README.zh-CN.md scripts/docs/verify-readme.mjs scripts/docs/test/readme-contract.test.mjs
git commit -m "docs: publish bilingual portfolio README"
```

### Task 5: Publish the walkthrough and final GitHub release

**Files:**
- Create: `docs/releases/v1.0.0-portfolio.md`
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `reports/demo/media-acceptance.md`

**Interfaces:**
- Consumes: ignored MP4, checked-in release notes, passing CI, GHCR immutable digest, externally verified demo.
- Produces: Git tag `v1.0.0-portfolio`, GitHub Release, asset `supplysentry-walkthrough-v1.0.0.mp4`, and final verified README links.

- [ ] **Step 1: Write release notes with evidence links**

State that data is synthetic, external receipts are simulated in public-demo mode, deterministic results are reproducible, credentialed model results are labeled separately, and production connectors are intentionally absent from the demo.

- [ ] **Step 2: Run final repository verification before tagging**

Run: `PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm typecheck && PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm test && PATH="/Users/etheralia/.nvm/versions/node/v24.20.0/bin:$PATH" pnpm eval:supplier-replies:check`

Expected: every command exits 0 on the exact commit to release.

- [ ] **Step 3: Push the verified commits and wait for mandatory GitHub checks**

Run: `git push origin main`

Expected: CI, demo image publication, seed, evaluation, build, and health checks succeed; GHCR exposes the commit-SHA image and advances `latest`.

- [ ] **Step 4: Create the release and upload MP4**

Run: `gh release create v1.0.0-portfolio artifacts/media/supplysentry-demo/supplysentry-walkthrough.mp4 --repo het2333/supply-sentry --title "SupplySentry Portfolio Release" --notes-file docs/releases/v1.0.0-portfolio.md`

Expected: release is public and the asset is named `supplysentry-walkthrough-v1.0.0.mp4` or is renamed before upload to that exact name.

- [ ] **Step 5: Add and verify final immutable links**

Update both READMEs with the public demo, GHCR package, and release asset URLs. Run `node scripts/docs/verify-readme.mjs` from an external network path and verify the GIF, poster, SVG, Demo, GHCR manifest, and MP4 release asset.

- [ ] **Step 6: Commit and push final link publication**

```bash
git add README.md README.zh-CN.md docs/releases/v1.0.0-portfolio.md reports/demo/media-acceptance.md
git commit -m "release: publish SupplySentry portfolio assets"
git push origin main
```
