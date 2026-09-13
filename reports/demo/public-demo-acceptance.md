# SupplySentry Public Demo Acceptance

Acceptance date: 2026-09-14. Scope: local isolated Docker stack at `127.0.0.1:3002`, tenant `t:public-demo`.

## Result

The exact working tree completed both verification modes against the eight-service local stack:

- `internal_reset`: entered the public session, reset and seeded generation 15, rejected a stale generation, mutated notifications, persisted a risk and audit activity, approved the synthetic 640/800 short delivery, updated the purchase-order projection, produced a `simulated_demo` receipt with `externalDelivery=false`, denied restricted surfaces, and reset to generation 16.
- `external_public`: repeated the public login, generation, business mutation, approval, projection, notification, audit, simulation, and denial checks without `READYWORK_INTERNAL_CALLBACK_TOKEN`. The verifier made no request to `/internal/demo/reset`.
- A final internal reset prepared generation 17 for media capture.

Both modes reported `ok: true`; five synthetic purchase orders were visible and every external action remained simulated.

## Runtime topology

All eight Compose services reached healthy/running state: Console, business API, control API, Temporal PostgreSQL, Temporal, Temporal worker, deterministic mock model, and reset worker. Only the Console was bound to host loopback port 3002.

## Publication boundary

This acceptance proves the repository's local public-demo workflow. It does not certify production connectors, hosted-model accuracy, customer data, or a current internet-hosted endpoint. Server capacity previously prepared for the demo has been reassigned; the README therefore advertises local Docker startup only.
