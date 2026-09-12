import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSensitive, redactSensitiveValue } from '../src/index.js';

test('redactSensitive removes authorization, JSON, key-value, URL, and environment credentials', () => {
  const environmentSecret = 'environment-secret-value';
  const previous = process.env['READYWORK_TEST_API_TOKEN'];
  process.env['READYWORK_TEST_API_TOKEN'] = environmentSecret;
  try {
    const secrets = [
      'bearer-secret', 'basic-secret', 'authorization-bearer-secret', 'json-secret',
      'json-password', 'quoted-secret', 'single-quoted-secret', 'plain-secret',
      'url-password', environmentSecret,
    ];
    const redacted = redactSensitive([
      'Bearer bearer-secret',
      'Authorization: Basic basic-secret',
      'Authorization=Bearer authorization-bearer-secret',
      '{"token":"json-secret","password": "json-password"}',
      'token="quoted-secret" secret=\'single-quoted-secret\' api_key=plain-secret',
      'https://alice:url-password@example.test/path',
      environmentSecret,
    ].join(' | '));

    assert.match(redacted, /\[REDACTED\]/);
    for (const secret of secrets) assert.doesNotMatch(redacted, new RegExp(secret));
  } finally {
    if (previous === undefined) delete process.env['READYWORK_TEST_API_TOKEN'];
    else process.env['READYWORK_TEST_API_TOKEN'] = previous;
  }
});

test('redactSensitiveValue recursively removes credential fields and credential-bearing strings', () => {
  const redacted = redactSensitiveValue({
    token: 'object-secret',
    maxTokens: 1600,
    token_usage_json: { prompt_tokens: 120, completion_tokens: 24 },
    nested: {
      note: '{"password":"embedded-secret"}',
      authorization: 'Basic object-basic-secret',
      apiToken: 'camel-case-secret',
    },
  });

  assert.deepEqual(redacted, {
    token: '[REDACTED]',
    maxTokens: 1600,
    token_usage_json: { prompt_tokens: 120, completion_tokens: 24 },
    nested: {
      note: '{"password":"[REDACTED]"}',
      authorization: '[REDACTED]',
      apiToken: '[REDACTED]',
    },
  });
  assert.doesNotMatch(JSON.stringify(redacted), /object-secret|embedded-secret|object-basic-secret|camel-case-secret/);
});
