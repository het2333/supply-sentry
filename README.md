# SupplySentry

English | [简体中文](README.zh-CN.md)

SupplySentry is an AI-assisted procurement execution platform for manufacturing teams. It brings purchase orders, supplier replies, delivery evidence, follow-up tasks, and human approvals into a shared workspace.

The repository contains a TypeScript monorepo with a Next.js console, separate business and control APIs, SQLite persistence, Temporal workflows, and connector integrations. Existing package names (`@readywork/*`), environment variables (`READYWORK_*`), and deployment service names retain the original Readywork identifiers.

## Product scope

The procurement V1 baseline follows the order lifecycle:

**PO sent → supplier commitment → fulfillment / production → dispatch / transit → delivery / goods receipt**

The codebase includes supplier-reply analysis, line-level order information, follow-up drafts, approvals, evidence history, risk and SLA views, and ERP / messaging integration boundaries. Available behavior depends on the configured connectors, identity provider, and runtime services.

The authoritative scope and release criteria are documented in [Procurement V1 Scope](docs/PROCUREMENT-V1-SCOPE.md) and [V1 Alignment and Acceptance](docs/NAVISIGHT-V1-ALIGNMENT.md). RFQ, accounts-payable, Teams, and general-purpose runtime components also exist in the repository; their presence is separate from procurement V1 acceptance.

## Repository layout

```text
apps/
  console/          Next.js procurement console
  api/              Shared business and control API implementation
  business-api/     Business API entry point
  control-plane-api/ Control API entry point
  temporal-worker/  Durable workflow worker
  mcp-bridge/       MCP bridge for agent tools
  validation/       Shared validation scenarios
  demo*/            Runtime and connector demonstration programs
  mock-model/       Deterministic model endpoint for local validation
packages/
  core/             Business contracts, policies, tasks, and approvals
  agent/            Agent runtime and DeepSeek Harness adapter
  persistence/      SQLite schema, migrations, and repositories
  context/          Manufacturing context and projections
  messaging/        Messaging contracts, persistence, and gateway
  connectors/       ERP and email integrations
  temporal-runtime/ Workflow definitions and client
  supply-chain/     Procurement employee pack and execution nodes
  workflow/         Workflow engine
infra/
  production/       Preview deployment image, topology, and contracts
  temporal/         Local and production Temporal definitions
  hermes/           Hermes bridge and onboarding services
scripts/            Integration checks and deployment packaging
docs/               Scope, architecture, runbooks, and design history
```

## Requirements

- **Node.js 22.18 or later**; Node.js 24 LTS is recommended. Node.js 20 lacks the `node:sqlite` capability used by this project.
- **pnpm 11.7.0**, pinned in `package.json`.
- Docker with Compose when running Temporal or the Hermes stack.
- Separately configured credentials for the external services you intend to use.

## Getting started

```bash
git clone https://github.com/het2333/supply-sentry.git
cd supply-sentry
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test:deploy:contracts
```

Start the APIs and console in separate terminals:

```bash
pnpm api:business     # http://127.0.0.1:4173
pnpm api:control      # http://127.0.0.1:4174
pnpm console         # http://127.0.0.1:3001
```

These commands start the application processes. Authentication, AI processing, durable workflows, and external connections require the corresponding environment configuration.

Configuration templates:

- [Root runtime example](.env.example)
- [Hermes example](infra/hermes/.env.example)
- [Server preview example](infra/production/.env.preview.example)

Provide actual values through your shell or deployment environment. Keep credentials in local configuration or the server secret store.

## Authentication and agent runtime

Demo authentication is disabled by default. Local development can explicitly enable `READYWORK_DEMO_AUTH=1` for the API process; it does not enable anonymous administrator access. Production rejects demo authentication and requires a production identity integration and an independent `READYWORK_SESSION_SECRET`.

The production AI runtime uses DeepSeek Harness. Configure `READYWORK_DSH_REPO` and the provider credentials before starting the Temporal worker. The in-memory adapter is an explicit test option.

```bash
pnpm infra:temporal:up
pnpm temporal:worker
```

See the [Temporal runbook](docs/TEMPORAL-V1-RUNBOOK.md) for setup and operations. ERP writes and outbound messages pass through business action controls and auditable execution records.

## Validation

```bash
pnpm typecheck
pnpm --dir apps/console exec tsc --noEmit --incremental false
pnpm test
pnpm test:deploy:contracts
pnpm --filter @readywork/app-console lint
pnpm --filter @readywork/app-console build
```

Runtime demonstrations are available through `pnpm demo`, `pnpm demo:dsh`, `pnpm demo:persist`, and `pnpm demo:mcp`. They validate selected runtime paths and are not evidence of a completed live procurement rollout.

## Deployment

[infra/production](infra/production) contains the preview Docker image and Compose topology. The [deployment scripts](scripts/deploy) package application code and a separately handled database backup, then verify the payload on the server.

Configure credentials and persistent storage before deployment. Release bundles can contain business data and are excluded from Git. The checked-in preview topology is specific to the existing environment; review the listen addresses and allowed origins for a new server.

The [Hermes integration guide](infra/hermes/README.md) covers the messaging bridge and its configuration.

## Source control and local data

This repository contains source code, tests, dependency lockfiles, deployment scripts, documentation, and required static assets.

The following remain local and are excluded by `.gitignore`:

- Environment secrets, API keys, email authorization codes, and private keys.
- Business databases, database backups, Hermes login state, and runtime sessions.
- Dependencies, compiled output, OCR language caches, logs, and test reports.
- Research checkouts, local agent work files, browser evidence, and release archives.

Back up `data/` and `.readywork/` separately. They contain application state and are not disposable build caches. Cloning this repository does not restore existing orders, user sessions, or service credentials.

Historical documents may refer to local `.research/`, `.superpowers/`, or `artifacts/` paths that are not included in the GitHub repository. The Chinese font used for document rendering and its license are retained under [apps/api/assets/fonts](apps/api/assets/fonts).

## Documentation

- [Product scope and acceptance criteria](docs/PROCUREMENT-V1-SCOPE.md)
- [Platform roadmap](docs/PLATFORM-ROADMAP.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Manufacturing context runbook](docs/MANUFACTURING-CONTEXT-RUNBOOK.md)
- [Temporal runbook](docs/TEMPORAL-V1-RUNBOOK.md)
- [Chinese project guide](README.zh-CN.md)

Detailed engineering documents currently remain in Chinese.
