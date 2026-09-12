import { createInterface } from 'node:readline';

let calls = 0;
const lines = createInterface({ input: process.stdin });

function reply(id, ok, result, error) {
  process.stdout.write(`${JSON.stringify({ id, ok, ...(result ? { result } : {}), ...(error ? { error } : {}) })}\n`);
}

lines.on('line', (line) => {
  const request = JSON.parse(line);
  calls += 1;
  if (request.method === 'health') return reply(request.id, true, { pid: process.pid, calls });
  if (request.method === 'shutdown') {
    reply(request.id, true, { pid: process.pid, calls });
    return;
  }
  reply(request.id, true, { pid: process.pid, calls, input: request.payload?.input });
});
