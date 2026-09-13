import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  AttachmentObjectStorageError,
  MemoryAttachmentObjectStorage,
  S3AttachmentObjectStorage,
  attachmentObjectKey,
  loadAttachmentObjectStorageConfig,
  type AttachmentObjectIntegrity,
  type S3AttachmentObjectStorageConfig,
} from '../src/attachment-object-storage.js';

const fixedNow = new Date('2026-08-22T00:00:00.000Z');
const bytes = new TextEncoder().encode('采购需求附件 / production object storage');
const digest = createHash('sha256').update(bytes).digest('hex');
const identity: AttachmentObjectIntegrity = {
  tenantId: 'tenant:a/../../other',
  attachmentId: 'attachment:报价/1',
  version: 3,
  sha256: digest,
  sizeBytes: bytes.byteLength,
};

function config(overrides: Partial<S3AttachmentObjectStorageConfig> = {}): S3AttachmentObjectStorageConfig {
  return {
    endpoint: 'https://minio.example.test',
    region: 'cn-test-1',
    bucket: 'readywork-attachments',
    accessKeyId: 'test-access-key',
    secretAccessKey: 'never-print-this-secret',
    forcePathStyle: true,
    serverSideEncryption: 'AES256',
    ...overrides,
  };
}

function objectHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-length': String(bytes.byteLength),
    'content-type': 'application/pdf',
    'x-amz-meta-readywork-sha256': digest,
    'x-amz-meta-readywork-size': String(bytes.byteLength),
    etag: '"etag-1"',
    ...extra,
  };
}

test('object keys are tenant/version scoped and traversal-safe', () => {
  const key = attachmentObjectKey(identity);
  assert.match(key, /^tenants\/[A-Za-z0-9_-]+\/procurement-attachments\/[A-Za-z0-9_-]+\/versions\/3\/content$/u);
  assert.doesNotMatch(key, /tenant:a|attachment:|\.\.|\/other/u);
  assert.notEqual(key, attachmentObjectKey({ ...identity, tenantId: 'tenant:b' }));
  assert.throws(() => attachmentObjectKey({ ...identity, version: 0 }), (error: unknown) => error instanceof AttachmentObjectStorageError && error.code === 'INVALID_INPUT');
});

test('memory adapter verifies bytes, returns copies, and deletes idempotently', async () => {
  const storage = new MemoryAttachmentObjectStorage({ now: () => fixedNow });
  await storage.put({ ...identity, body: bytes, contentType: 'application/pdf' });
  const first = await storage.get(identity);
  assert.deepEqual(first.body, bytes);
  first.body[0] = 0;
  assert.deepEqual((await storage.get(identity)).body, bytes);
  assert.equal((await storage.head(identity))?.sha256, digest);
  const signed = await storage.createSignedGetUrl({ ...identity, expiresInSeconds: 60 });
  assert.equal(signed.expiresAt, '2026-08-22T00:01:00.000Z');
  await assert.rejects(
    storage.get({ ...identity, sha256: '0'.repeat(64) }),
    (error: unknown) => error instanceof AttachmentObjectStorageError && error.code === 'INTEGRITY_MISMATCH',
  );
  await storage.delete(identity);
  await storage.delete(identity);
  assert.equal(await storage.head(identity), null);
});

test('put rejects a body that does not match the database integrity record', async () => {
  const storage = new MemoryAttachmentObjectStorage();
  await assert.rejects(
    storage.put({ ...identity, body: new TextEncoder().encode('tampered'), contentType: 'application/pdf' }),
    (error: unknown) => error instanceof AttachmentObjectStorageError && error.code === 'INTEGRITY_MISMATCH',
  );
});

test('production configuration fails closed and never exposes secret values', () => {
  assert.throws(
    () => loadAttachmentObjectStorageConfig({ NODE_ENV: 'production' }),
    (error: unknown) => error instanceof AttachmentObjectStorageError && error.code === 'CONFIGURATION_ERROR' && !error.message.includes('secret-value'),
  );
  assert.equal(loadAttachmentObjectStorageConfig({ NODE_ENV: 'development' }), undefined);
  const environment = {
    NODE_ENV: 'production',
    READYWORK_ATTACHMENT_OBJECT_STORAGE: 's3',
    READYWORK_S3_ENDPOINT: 'https://minio.example.test',
    READYWORK_S3_REGION: 'cn-test-1',
    READYWORK_S3_BUCKET: 'readywork-attachments',
    READYWORK_S3_ACCESS_KEY_ID: 'access-value',
    READYWORK_S3_SECRET_ACCESS_KEY: 'secret-value',
    READYWORK_S3_SERVER_SIDE_ENCRYPTION: 'AES256',
  };
  const loaded = loadAttachmentObjectStorageConfig(environment);
  assert.equal(loaded?.forcePathStyle, true);
  assert.equal(loaded?.signedGetTtlSeconds, 300);
  const serializedAdapter = JSON.stringify(new S3AttachmentObjectStorage(loaded!));
  assert.equal(serializedAdapter.includes('secret-value'), false);
});

test('public demo production mode starts without object storage credentials because uploads are disabled', () => {
  assert.equal(loadAttachmentObjectStorageConfig({
    NODE_ENV: 'production',
    READYWORK_PUBLIC_DEMO: '1',
    READYWORK_PUBLIC_DEMO_TENANT: 't:public-demo',
    READYWORK_PUBLIC_DEMO_SIMULATION_POLICY: 'simulated_demo',
  }), undefined);
});

test('S3 adapter exposes its effective request timeout to lease coordinators', () => {
  const configured = new S3AttachmentObjectStorage(config({ requestTimeoutMs: 4_321 }));
  const defaulted = new S3AttachmentObjectStorage(config());
  assert.equal(Reflect.get(configured, 'requestTimeoutMs'), 4_321);
  assert.equal(Reflect.get(defaulted, 'requestTimeoutMs'), 15_000);
});

test('plain HTTP MinIO and incomplete KMS configuration are denied by default', () => {
  const plain = {
    NODE_ENV: 'production',
    READYWORK_ATTACHMENT_OBJECT_STORAGE: 's3',
    READYWORK_S3_ENDPOINT: 'http://127.0.0.1:9000',
    READYWORK_S3_REGION: 'us-east-1',
    READYWORK_S3_BUCKET: 'readywork-attachments',
    READYWORK_S3_ACCESS_KEY_ID: 'access',
    READYWORK_S3_SECRET_ACCESS_KEY: 'secret',
  };
  assert.throws(() => loadAttachmentObjectStorageConfig(plain), /明文对象存储端点已拒绝/u);
  const allowed = loadAttachmentObjectStorageConfig({ ...plain, READYWORK_S3_ALLOW_INSECURE_ENDPOINT: '1' });
  assert.equal(allowed?.allowInsecureEndpoint, true);
  assert.throws(
    () => loadAttachmentObjectStorageConfig({ ...plain, READYWORK_S3_ALLOW_INSECURE_ENDPOINT: '1', READYWORK_S3_SERVER_SIDE_ENCRYPTION: 'aws:kms' }),
    /READYWORK_S3_KMS_KEY_ID/u,
  );
});

test('S3 adapter signs PUT and GET, enforces SSE, and verifies remote bytes', async () => {
  const requests: Array<{ url: URL; init: RequestInit; headers: Headers }> = [];
  const storage = new S3AttachmentObjectStorage(config(), {
    now: () => fixedNow,
    fetch: async (input, init = {}) => {
      requests.push({ url: new URL(input), init, headers: new Headers(init.headers) });
      if (init.method === 'PUT') return new Response(null, { status: 200, headers: { etag: '"etag-upload"', 'x-amz-version-id': 's3-version-1' } });
      if (init.method === 'GET') return new Response(bytes, { status: 200, headers: objectHeaders() });
      throw new Error(`unexpected method ${String(init.method)}`);
    },
  });
  const uploaded = await storage.put({ ...identity, body: bytes, contentType: 'application/pdf' });
  assert.equal(uploaded.etag, 'etag-upload');
  assert.equal(uploaded.storageVersionId, 's3-version-1');
  const put = requests[0]!;
  assert.equal(put.init.method, 'PUT');
  assert.match(put.url.pathname, /^\/readywork-attachments\/tenants\//u);
  assert.equal(put.headers.get('x-amz-server-side-encryption'), 'AES256');
  assert.equal(put.headers.get('x-amz-meta-readywork-sha256'), digest);
  assert.equal(put.headers.get('x-amz-content-sha256'), digest);
  assert.match(put.headers.get('authorization') ?? '', /^AWS4-HMAC-SHA256 Credential=test-access-key\//u);
  assert.equal((put.headers.get('authorization') ?? '').includes('never-print-this-secret'), false);
  const downloaded = await storage.get(identity);
  assert.deepEqual(downloaded.body, bytes);
  assert.equal(downloaded.metadata.etag, 'etag-1');
});

test('S3 adapter rejects missing or mismatched integrity metadata', async () => {
  const storage = new S3AttachmentObjectStorage(config(), {
    now: () => fixedNow,
    fetch: async () => new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength), 'content-type': 'application/pdf' } }),
  });
  await assert.rejects(
    storage.get(identity),
    (error: unknown) => error instanceof AttachmentObjectStorageError && error.code === 'INTEGRITY_MISMATCH',
  );
});

test('signed GET URL is short-lived, integrity-gated, and contains no secret', async () => {
  const requests: URL[] = [];
  const storage = new S3AttachmentObjectStorage(config({ forcePathStyle: false, sessionToken: 'temporary-session-token' }), {
    now: () => fixedNow,
    fetch: async (input, init) => {
      requests.push(new URL(input));
      assert.equal(init?.method, 'HEAD');
      return new Response(null, { status: 200, headers: objectHeaders() });
    },
  });
  const signed = await storage.createSignedGetUrl({ ...identity, expiresInSeconds: 120 });
  const parsed = new URL(signed.url);
  assert.equal(requests[0]?.hostname, 'readywork-attachments.minio.example.test');
  assert.equal(parsed.hostname, 'readywork-attachments.minio.example.test');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '120');
  assert.equal(parsed.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.match(parsed.searchParams.get('X-Amz-Signature') ?? '', /^[a-f0-9]{64}$/u);
  assert.equal(parsed.searchParams.get('X-Amz-Security-Token'), 'temporary-session-token');
  assert.equal(signed.expiresAt, '2026-08-22T00:02:00.000Z');
  assert.equal(signed.url.includes('never-print-this-secret'), false);
  await assert.rejects(storage.createSignedGetUrl({ ...identity, expiresInSeconds: 901 }), /1-900/u);
});

test('S3 HEAD returns null for a missing object without weakening other errors', async () => {
  const missing = new S3AttachmentObjectStorage(config(), { now: () => fixedNow, fetch: async () => new Response(null, { status: 404 }) });
  assert.equal(await missing.head(identity), null);
  const denied = new S3AttachmentObjectStorage(config(), { now: () => fixedNow, fetch: async () => new Response(null, { status: 403 }) });
  await assert.rejects(
    denied.head(identity),
    (error: unknown) => error instanceof AttachmentObjectStorageError && error.code === 'REMOTE_ERROR' && error.statusCode === 403 && !error.message.includes('never-print-this-secret'),
  );
});
