# Readywork Aliyun Server Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the existing Readywork workspace to `47.102.116.148` as a private, reproducible Docker Compose preview with migrated business data and no public exposure of demo authentication.

**Architecture:** Build one pinned Node.js application image and run Console, Business API, Control API, and Temporal Worker as separate Compose services sharing a server-side data volume. Run Temporal with PostgreSQL and keep every Readywork, Temporal, and Hermes port bound to server loopback. Migrate a verified SQLite backup and reconfigure encrypted third-party credentials on the server instead of copying plaintext secrets.

**Tech Stack:** Ubuntu 24.04, Docker Engine with Compose v2, Node.js 22.18, pnpm 11.7.0, Next.js 16.3.3, SQLite, PostgreSQL 16, Temporal 1.28.1, Hermes Agent v2026.9.7.

**Spec:** `docs/superpowers/specs/2026-09-10-aliyun-server-deployment-design.md`

## Global Constraints

- The preview remains private behind SSH tunnelling; no Readywork business port is bound to `0.0.0.0` on the server host.
- `READYWORK_DEMO_AUTH=1` is allowed only in preview mode and must never be paired with public Console/API exposure.
- No password, API key, mailbox authorization code, session secret, credential key, or Hermes token enters source control, image layers, logs, or chat.
- The local deployment and local business database remain intact until separate cutover authorization.
- The migrated SQLite database must pass `PRAGMA integrity_check` before and after transfer.
- Connector states are not treated as healthy until server-side protocol tests produce new observations.
- This workspace has no Git metadata; release IDs, checksums, immutable release directories, and retained backups provide the rollback boundary instead of commits.

---

### Task 1: Reproducible Readywork application image

**Files:**
- Create: `.dockerignore`
- Create: `infra/production/Dockerfile`
- Create: `infra/production/test/image-contract.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: root pnpm workspace and lockfile.
- Produces: image target `readywork-app` with Node `22.18.x`, pnpm `11.7.0`, production Console build, runtime source, and a non-root `readywork` user.

- [ ] **Step 1: Write the image contract test**

The test reads `infra/production/Dockerfile` and asserts a pinned Node 22.18 base, lockfile-frozen installation, Console production build, non-root final user, and absence of `COPY .env` patterns.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test infra/production/test/image-contract.test.mjs`

Expected: FAIL because `infra/production/Dockerfile` does not exist.

- [ ] **Step 3: Add the Docker build boundary**

Use a multi-stage Debian slim image. The dependency stage runs:

```dockerfile
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
RUN pnpm install --frozen-lockfile
```

The build stage runs:

```dockerfile
RUN pnpm --filter @readywork/app-console build
```

The runtime stage keeps the workspace packages needed by the existing `tsx` commands, creates `/app/data` and `/app/.readywork`, changes ownership to the `readywork` user, and does not embed environment files.

- [ ] **Step 4: Add deterministic build inputs**

Exclude `.git`, `.next`, `node_modules`, `.readywork`, local logs, temporary files, database backups, and secret env files. Keep source migrations, the empty data directory boundary, Hermes plugin source, and the lockfile.

- [ ] **Step 5: Run the image contract and local image build**

Run:

```bash
node --test infra/production/test/image-contract.test.mjs
docker build -f infra/production/Dockerfile -t readywork-app:preview .
docker run --rm readywork-app:preview node --version
```

Expected: contract PASS, image build exit `0`, Node output starts with `v22.18`.

### Task 2: Private Compose topology and secret contract

**Files:**
- Create: `infra/production/compose.preview.yml`
- Create: `infra/production/.env.preview.example`
- Create: `infra/production/test/compose-contract.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `readywork-app:preview` from Task 1 and the existing Temporal production image versions.
- Produces: services `console`, `business-api`, `control-api`, `temporal-worker`, `temporal`, and `temporal-db`; loopback-only published ports; shared `/opt/readywork/shared/data` mount.

- [ ] **Step 1: Write the failing Compose contract test**

Assert that every host port begins with `127.0.0.1:`, all mutable Readywork services mount the same data path, required secrets use Compose required-variable syntax, restart policy is `unless-stopped`, and demo anonymous authentication is absent.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test infra/production/test/compose-contract.test.mjs`

Expected: FAIL because the preview Compose file does not exist.

- [ ] **Step 3: Implement the preview topology**

Set service commands to the existing scripts:

```yaml
business-api: pnpm api:business
control-api: pnpm api:control
temporal-worker: pnpm temporal:worker
console: pnpm --dir apps/console start
```

Use internal service URLs for Console rewrites, `DB_PATH=/app/data/readywork.sqlite`, `TEMPORAL_ADDRESS=temporal:7233`, `READYWORK_API_HOST=0.0.0.0`, unique required secrets, and health checks for the two APIs and Console.

- [ ] **Step 4: Add an example env contract without values**

List only variable names and safe descriptions. Do not include usable defaults for session, credential, Temporal, internal callback, collaboration, or Hermes bridge secrets.

- [ ] **Step 5: Verify rendered Compose configuration**

Run:

```bash
node --test infra/production/test/compose-contract.test.mjs
docker compose --env-file infra/production/.env.preview.example -f infra/production/compose.preview.yml config --quiet
```

Expected: test PASS; Compose validation either succeeds with generated test-only environment values or fails only for explicitly required secrets, never for schema or interpolation errors.

### Task 3: Consistent data bundle and rollback scripts

**Files:**
- Create: `scripts/deploy/create-preview-bundle.sh`
- Create: `scripts/deploy/verify-preview-data.sh`
- Create: `infra/production/test/deployment-scripts-contract.test.mjs`

**Interfaces:**
- Consumes: `data/readywork.sqlite`, required attachment objects, and `data/hermes`.
- Produces: a release tar archive, SHA-256 manifest, SQLite integrity result, and a server-side pre-deploy backup.

- [ ] **Step 1: Write the failing script contract test**

Assert strict shell mode, explicit workspace paths, SQLite `.backup`, integrity checking, SHA-256 manifest generation, exclusions for logs/caches/env files, and no destructive recursive deletion.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test infra/production/test/deployment-scripts-contract.test.mjs`

Expected: FAIL because the deployment scripts do not exist.

- [ ] **Step 3: Implement the local bundle creator**

Use `mktemp -d`, `sqlite3 "$db" ".backup '$staging/data/readywork.sqlite'"`, `PRAGMA integrity_check`, and `tar` with explicit source paths. Generate `SHA256SUMS` after the archive content is frozen.

- [ ] **Step 4: Implement server-side verification**

Verify the manifest before extracting into a new `/opt/readywork/releases/$release_id`, verify the copied SQLite database, create `/opt/readywork/shared/backups/$release_id`, and refuse to overwrite an existing release directory.

- [ ] **Step 5: Exercise scripts against an isolated temporary directory**

Run the contract test, create a local bundle, unpack it into `mktemp -d`, and run the verification script there. Confirm the source database hash and modification time do not change.

### Task 4: Establish scoped deployment access and release to Aliyun

**Files:**
- Create outside repository: `~/.ssh/readywork_aliyun_deploy_ed25519`
- Create on server: `/home/admin/.ssh/authorized_keys` entry labeled `readywork-deploy`
- Create on server: `/opt/readywork/releases/$release_id`
- Create on server: `/opt/readywork/shared/env/preview.env`

**Interfaces:**
- Consumes: public host `47.102.116.148`, release bundle, image/Compose definitions, and a task-scoped SSH public key.
- Produces: non-interactive SSH access limited to the `admin` account and a running private Compose deployment.

- [ ] **Step 1: Generate a dedicated local deployment key**

Run `ssh-keygen -t ed25519 -f ~/.ssh/readywork_aliyun_deploy_ed25519 -N '' -C readywork-deploy` only if that exact path does not exist.

- [ ] **Step 2: Ask the logged-in server operator to append only the public key**

Provide one `install -d -m 700 ~/.ssh` plus `printf` command containing the public key. Never request the server password or private key.

- [ ] **Step 3: Verify scoped access and server prerequisites**

Use `ssh -o BatchMode=yes -i ~/.ssh/readywork_aliyun_deploy_ed25519 admin@47.102.116.148` to inspect resources, Docker/Compose availability, time synchronization, and port use. Install Docker only if absent, using Ubuntu's signed repository, then re-run version checks.

- [ ] **Step 4: Transfer the immutable release**

Use `rsync` over the dedicated key into a newly generated release directory. Compare local and remote SHA-256 manifests before any service start.

- [ ] **Step 5: Generate server-only secrets and start services**

Generate independent random values with `openssl rand -hex 32`, store the env file with mode `600`, point shared data symlinks at the verified migration, build the image, and run `docker compose up -d --wait`.

- [ ] **Step 6: Retain rollback state**

Record the previous `current` symlink target, Compose image ID, data checksum, and backup directory. Do not remove previous releases or the local deployment.

### Task 5: End-to-end private preview verification

**Files:**
- Create: `scripts/deploy/verify-preview-runtime.sh`
- Modify: `docs/DEPLOYMENT-RUNBOOK.md`

**Interfaces:**
- Consumes: running server Compose project and SSH access.
- Produces: machine-readable pass/fail checks and user-facing access command.

- [ ] **Step 1: Write runtime checks**

Verify Compose health, API `/health` responses, Console HTTP response, SQLite integrity, expected migration version, key procurement document counts, target PO existence, restart policy, and absence of non-loopback Readywork listeners.

- [ ] **Step 2: Run the checks before deployment to establish failure**

Expected: FAIL because no Readywork Compose project is running on the server.

- [ ] **Step 3: Run checks after deployment**

Expected: all checks PASS with zero failed containers, API service versions present, SQLite `ok`, and no Readywork port exposed publicly.

- [ ] **Step 4: Verify browser persistence through an SSH tunnel**

Open a local tunnel mapping local `13001` to server `127.0.0.1:3001`, log in through the Readywork page, open `PO-2026090502`, refresh, and confirm the same persistent facts remain.

- [ ] **Step 5: Document public cutover gates**

Document the exact prerequisites for Caddy HTTPS: registered domain, production IdP, OSS/S3, production session and credential secrets, connector reconfiguration, security-group rules limited to `80/443`, and successful WeCom callback validation. Do not describe private preview as production-ready.
