import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { resolveEmailTransportMode } from '../src/messaging/email-transport-mode.js';
import { MessagingRuntimeRegistry } from '../src/messaging/runtime.js';

test('Email transport mode defaults to native and rejects dual or unknown delivery paths', () => {
  assert.equal(resolveEmailTransportMode({}), 'native');
  assert.equal(resolveEmailTransportMode({ READYWORK_EMAIL_TRANSPORT_MODE: 'native' }), 'native');
  assert.equal(resolveEmailTransportMode({ READYWORK_EMAIL_TRANSPORT_MODE: 'hermes' }), 'hermes');
  assert.throws(() => resolveEmailTransportMode({ READYWORK_EMAIL_TRANSPORT_MODE: 'both' }), /native.*hermes/u);
  assert.throws(() => resolveEmailTransportMode({ READYWORK_EMAIL_TRANSPORT_MODE: ' ' }), /native.*hermes/u);
  assert.throws(() => resolveEmailTransportMode({ READYWORK_EMAIL_TRANSPORT_MODE: 'smtp' }), /native.*hermes/u);
});

test('Messaging runtime registers exactly one Email transport path', () => {
  for (const mode of ['native', 'hermes'] as const) {
    const store = openPersistence(':memory:', { tenantId: `tenant:${mode}` });
    try {
      const registry = new MessagingRuntimeRegistry(store.db, () => ({
        listCredentials: () => [],
        getCredential: () => undefined,
      }), {
        emailTransportMode: mode,
        hermesBridge: {
          baseUrl: 'http://127.0.0.1:8788',
          secret: 'bridge-secret-with-at-least-thirty-two-bytes',
          fetch: async () => new Response('{}'),
        },
      });
      const runtime = registry.forTenant(`tenant:${mode}`);
      runtime.synchronizeHermesPlatforms([
        { id: 'email', enabled: true, configured: true, state: 'connected' },
      ]);
      const emailStates = runtime.adapterStates().filter((state) => state.channel === 'email');
      assert.equal(emailStates.length, 1, mode);
      assert.equal(emailStates[0]!.provider, mode === 'native' ? 'smtp' : 'hermes-gateway');
      assert.equal(emailStates[0]!.adapterId, 'email');
    } finally {
      store.close();
    }
  }
});
