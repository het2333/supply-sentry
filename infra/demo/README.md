# SupplySentry public demo stack

This stack is intentionally separate from production. It uses only synthetic tenant `t:public-demo`, records external actions as simulated receipts, and stores state in dedicated Docker volumes.

```bash
./scripts/demo/demo.sh up
```

Build locally instead of pulling the published image:

```bash
READYWORK_DEMO_IMAGE=readywork-demo:local ./scripts/demo/demo.sh up --build
```

The default address is <http://127.0.0.1:3002/>. Use `logs`, `reset`, and `down` for routine operation. `down` preserves data; `purge` is the only command that removes the two demo volumes and requires typing the exact word `purge`.

The topology never mounts production paths, Hermes state, customer databases, connector credentials, or hosted-model keys. Only the console publishes a host port.
