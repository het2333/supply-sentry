import { writeFile } from 'node:fs/promises';

const baseUrl = process.env.READYWORK_DEMO_API_URL ?? 'http://business-api:4173';
const token = process.env.READYWORK_INTERNAL_CALLBACK_TOKEN;
const configuredInterval = Number(process.env.READYWORK_DEMO_RESET_INTERVAL_MS ?? 3_600_000);
const intervalMs = Number.isSafeInteger(configuredInterval) ? Math.max(60_000, configuredInterval) : 3_600_000;

if (process.env.READYWORK_PUBLIC_DEMO !== '1'
  || process.env.READYWORK_PUBLIC_DEMO_TENANT !== 't:public-demo'
  || process.env.READYWORK_PUBLIC_DEMO_SIMULATION_POLICY !== 'simulated_demo') {
  throw new Error('Public demo reset worker isolation configuration is invalid');
}
if (!token) throw new Error('READYWORK_INTERNAL_CALLBACK_TOKEN is required');

async function reset() {
  const response = await fetch(`${baseUrl}/internal/demo/reset`, {
    method: 'POST',
    headers: { 'x-readywork-internal-token': token },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Public demo reset failed (${response.status})`);
  const result = await response.json();
  if (!Number.isSafeInteger(result.generation) || result.generation < 1) throw new Error('Public demo reset returned an invalid generation');
  await writeFile('/tmp/readywork-demo-reset-ready', String(result.generation), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'public_demo.reset.completed', generation: result.generation, resetAt: result.resetAt }));
}

await reset();
setInterval(() => void reset().catch((error) => {
  console.error(JSON.stringify({ event: 'public_demo.reset.failed', error: error instanceof Error ? error.message : 'unknown' }));
}), intervalMs);
