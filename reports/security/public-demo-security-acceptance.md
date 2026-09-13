# SupplySentry Public Demo Security Acceptance

Acceptance scope: the isolated public portfolio demo defined by `infra/demo/compose.yml`. This report does not certify a production deployment and does not cover production connectors, customer data, or a credentialed hosted-model runtime.

## Decision

The local public-demo build is accepted for publication as a one-command Docker demo. Its trust boundary is a dedicated synthetic tenant and dedicated Docker storage; all externally visible actions are intercepted as simulated receipts. No hosted endpoint is currently advertised.

## Verified boundaries

| Control | Evidence | Result |
| --- | --- | --- |
| Only the Console is published | `infra/demo/compose.yml` contains the stack's only `ports:` mapping on `console`; APIs, mock model, Temporal, PostgreSQL, worker, and reset worker remain on the private `demo` network. | Pass |
| Local bind is loopback-only | `scripts/demo/demo.sh` creates `READYWORK_DEMO_BIND_ADDRESS=127.0.0.1` and port `3002`. | Pass |
| Server bind is explicit | `scripts/demo/deploy-server.sh` creates and re-checks `READYWORK_DEMO_BIND_ADDRESS=0.0.0.0` and port `3002`. | Pass by deployment contract; no active hosted deployment |
| Deployment directory is isolated | The server script refuses every target other than `/opt/supplysentry-demo` and explicitly forbids `/opt/readywork/shared`. | Pass |
| Business and workflow storage are separate | Business state uses `supplysentry_demo_data`; Temporal PostgreSQL uses `supplysentry_demo_temporal_data`. | Pass |
| Production state is not mounted | The Compose topology mounts only the two named demo volumes. It does not mount production SQLite files, `/opt/readywork/shared`, Hermes state, customer files, or host credential directories. | Pass |
| No production connector or model credential is required | The public stack uses the internal `mock-model`, `READYWORK_AGENT_RUNTIME=inmemory`, and a non-secret demo-only model token. SMTP/IMAP, Hermes, ERP, and DeepSeek credentials are absent from the topology. | Pass |
| Tenant is fixed | Every service receives `READYWORK_PUBLIC_DEMO=1` and `READYWORK_PUBLIC_DEMO_TENANT=t:public-demo`; persistence schemas also constrain demo state to that tenant. | Pass |
| External side effects are intercepted | The simulation policy is fixed to `simulated_demo`. The acceptance verifier requires `receiptKind=simulated_demo` and `externalDelivery=false`. | Pass |
| Stale writes after reset are rejected | Mutation requests carry the public-demo generation. The verifier proves an old generation returns HTTP `409` with `DEMO_GENERATION_CONFLICT`. | Pass |
| High-risk capabilities fail closed | Configuration, document upload, and inbound webhook probes each return HTTP `403` with `PUBLIC_DEMO_CAPABILITY_DISABLED`. | Pass |
| Reset restores the published scenario baseline | Reset advances the generation, removes the verifier's injected risk, restores unread notifications, and restores the original PO count. The seed contract contains 5 purchase orders across 8 scenarios. | Pass |
| Secrets are generated outside source control | Local and server scripts generate session/internal/Temporal secrets into ignored mode-`0600` environment files. Values are never printed by the acceptance workflow. | Pass |

## Local end-to-end acceptance evidence

The full eight-service Docker topology was started locally and `scripts/demo/verify-public-demo.mjs` completed successfully against the Console proxy in both modes. Internal mode covered reset, entry, session establishment, seeded workbench loading, stale-generation denial, notification mutation, risk persistence, executable short-delivery approval, projection update, simulated external action, capability denials, and final reset. Credential-free external mode repeated the public boundary checks and did not call the internal reset endpoint.

Observed result:

```json
{
  "ok": true,
  "verificationMode": "internal_reset",
  "tenantId": "t:public-demo",
  "generation": 16,
  "purchaseOrders": 5,
  "approval": "approved",
  "simulatedReceipt": {
    "receiptKind": "simulated_demo",
    "externalDelivery": false
  },
  "resetRestored": true,
  "resetVerification": "verified_internal"
}
```

The generation value is expected to change on later executions. It is evidence of the recorded run, not a fixed product constant.

## Future hosted deployment acceptance checklist

Before the README may describe any URL as an online demo, the exact released image must pass all of the following on the selected server:

1. GHCR image for the released commit is pulled successfully.
2. `docker compose ... up -d --wait` reports all eight services healthy/running.
3. The verifier runs from inside `control-api` against `http://console:3001` and returns `ok: true`.
4. An external request to the candidate public URL succeeds without an internal token.
5. No API, Temporal, PostgreSQL, or mock-model port is externally published.
6. The deployment directory is `/opt/supplysentry-demo`; neither `/opt/readywork/shared` nor any production volume is referenced.

Hosted status: **paused; no public endpoint is currently advertised**.

## Residual risk

- This is an anonymous public portfolio environment, so rate limits and periodic reset reduce abuse but do not replace a production identity provider or WAF.
- The public demo proves deterministic behavior with synthetic data and a mock/in-memory AI runtime. It does not prove hosted-model accuracy or production connector availability.
- Plain HTTP is approved only for this IP-address demo. Production use requires HTTPS, a controlled domain, formal identity integration, secret management, backups, monitoring, and incident response.
