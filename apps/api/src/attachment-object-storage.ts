import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const MAX_SIGNED_URL_TTL_SECONDS = 900;
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

export interface AttachmentObjectIdentity {
  readonly tenantId: string;
  readonly attachmentId: string;
  readonly version: number;
}

export interface AttachmentObjectIntegrity extends AttachmentObjectIdentity {
  /** Lower-case hexadecimal SHA-256 recorded in the application database. */
  readonly sha256: string;
  /** Byte length recorded in the application database. */
  readonly sizeBytes: number;
}

export interface PutAttachmentObjectInput extends AttachmentObjectIntegrity {
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface AttachmentObjectMetadata extends AttachmentObjectIntegrity {
  readonly key: string;
  readonly contentType: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly storageVersionId?: string;
  readonly serverSideEncryption?: S3ServerSideEncryption;
}

export interface AttachmentObjectValue {
  readonly body: Uint8Array;
  readonly metadata: AttachmentObjectMetadata;
}

export interface SignedAttachmentObjectUrl {
  readonly url: string;
  readonly expiresAt: string;
}

export interface AttachmentObjectStorage {
  /** Upper bound for one remote request, when the adapter enforces one. */
  readonly requestTimeoutMs?: number;
  put(input: PutAttachmentObjectInput): Promise<AttachmentObjectMetadata>;
  get(input: AttachmentObjectIntegrity): Promise<AttachmentObjectValue>;
  delete(input: AttachmentObjectIdentity): Promise<void>;
  head(input: AttachmentObjectIntegrity): Promise<AttachmentObjectMetadata | null>;
  createSignedGetUrl(input: AttachmentObjectIntegrity & { readonly expiresInSeconds?: number }): Promise<SignedAttachmentObjectUrl>;
}

export type S3ServerSideEncryption = 'AES256' | 'aws:kms';

export interface S3AttachmentObjectStorageConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly forcePathStyle?: boolean;
  readonly serverSideEncryption?: S3ServerSideEncryption;
  readonly kmsKeyId?: string;
  readonly signedGetTtlSeconds?: number;
  readonly requestTimeoutMs?: number;
  /** Required for an http:// MinIO endpoint. Never enable this for Internet-facing storage. */
  readonly allowInsecureEndpoint?: boolean;
}

export class AttachmentObjectStorageError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_INPUT'
      | 'CONFIGURATION_ERROR'
      | 'NOT_FOUND'
      | 'INTEGRITY_MISMATCH'
      | 'REMOTE_ERROR'
      | 'REQUEST_TIMEOUT',
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'AttachmentObjectStorageError';
  }
}

type ObjectStorageFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;
type ObjectStorageRequestBody = NonNullable<RequestInit['body']>;

interface S3AttachmentObjectStorageOptions {
  readonly fetch?: ObjectStorageFetch;
  readonly now?: () => Date;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Uint8Array | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function assertSafeIdentifier(label: string, value: string): void {
  if (!value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new AttachmentObjectStorageError('INVALID_INPUT', `${label} 无效`);
  }
}

function assertIdentity(input: AttachmentObjectIdentity): void {
  assertSafeIdentifier('tenantId', input.tenantId);
  assertSafeIdentifier('attachmentId', input.attachmentId);
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new AttachmentObjectStorageError('INVALID_INPUT', '附件版本必须是正整数');
  }
}

function assertIntegrity(input: Pick<AttachmentObjectIntegrity, 'sha256' | 'sizeBytes'>): void {
  if (!/^[a-f0-9]{64}$/u.test(input.sha256)) {
    throw new AttachmentObjectStorageError('INVALID_INPUT', '附件 SHA-256 无效');
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new AttachmentObjectStorageError('INVALID_INPUT', '附件大小无效');
  }
}

function assertContentType(contentType: string): void {
  if (!contentType || contentType.length > 255 || /[\r\n]/u.test(contentType)) {
    throw new AttachmentObjectStorageError('INVALID_INPUT', '附件 Content-Type 无效');
  }
}

function safeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/**
 * Builds a traversal-safe, tenant-scoped key without exposing raw tenant or
 * attachment identifiers in logs, URLs or object-store consoles.
 */
export function attachmentObjectKey(input: AttachmentObjectIdentity): string {
  assertIdentity(input);
  return `tenants/${safeSegment(input.tenantId)}/procurement-attachments/${safeSegment(input.attachmentId)}/versions/${input.version}/content`;
}

function equalHash(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function verifyBody(input: AttachmentObjectIntegrity, body: Uint8Array): void {
  if (body.byteLength !== input.sizeBytes || !equalHash(sha256(body), input.sha256)) {
    throw new AttachmentObjectStorageError('INTEGRITY_MISMATCH', '对象内容与附件完整性记录不一致');
  }
}

function verifyMetadata(input: AttachmentObjectIntegrity, sizeBytes: number, objectSha256: string | null): void {
  if (sizeBytes !== input.sizeBytes || !objectSha256 || !equalHash(objectSha256.toLowerCase(), input.sha256)) {
    throw new AttachmentObjectStorageError('INTEGRITY_MISMATCH', '对象元数据与附件完整性记录不一致');
  }
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(entries: ReadonlyArray<readonly [string, string]>): string {
  return entries
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function normalizedHeaderValue(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function amzDates(value: Date): { dateTime: string; date: string } {
  if (Number.isNaN(value.getTime())) throw new AttachmentObjectStorageError('INVALID_INPUT', '签名时间无效');
  const dateTime = value.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  return { dateTime, date: dateTime.slice(0, 8) };
}

function signingKey(secret: string, date: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

function signature(secret: string, date: string, region: string, stringToSign: string): string {
  return createHmac('sha256', signingKey(secret, date, region)).update(stringToSign).digest('hex');
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', `${name} 必须为 true/false 或 1/0`);
}

function parseBoundedInteger(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', `${name} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return parsed;
}

function requireConfiguration(env: Readonly<Record<string, string | undefined>>, names: readonly string[]): Record<string, string> {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', `对象存储缺少配置：${missing.join(', ')}`);
  }
  return Object.fromEntries(names.map((name) => [name, env[name]!.trim()]));
}

/**
 * Loads S3/MinIO configuration. Production fails closed: database-only or an
 * implicit storage backend is not accepted. The isolated public demo is the
 * sole exception because uploads are denied before body reads and it must not
 * receive storage credentials. Error messages name variables, never values.
 */
export function loadAttachmentObjectStorageConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): S3AttachmentObjectStorageConfig | undefined {
  const isolatedPublicDemo = env['READYWORK_PUBLIC_DEMO'] === '1'
    && env['READYWORK_PUBLIC_DEMO_TENANT'] === 't:public-demo'
    && env['READYWORK_PUBLIC_DEMO_SIMULATION_POLICY'] === 'simulated_demo';
  if (isolatedPublicDemo) return undefined;
  const production = env['NODE_ENV'] === 'production';
  const backend = env['READYWORK_ATTACHMENT_OBJECT_STORAGE']?.trim().toLowerCase();
  if (!backend) {
    if (production) throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', '生产环境必须配置 READYWORK_ATTACHMENT_OBJECT_STORAGE=s3');
    return undefined;
  }
  if (backend !== 's3') {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', `不支持的附件对象存储类型；READYWORK_ATTACHMENT_OBJECT_STORAGE 必须为 s3`);
  }
  const required = requireConfiguration(env, [
    'READYWORK_S3_ENDPOINT',
    'READYWORK_S3_REGION',
    'READYWORK_S3_BUCKET',
    'READYWORK_S3_ACCESS_KEY_ID',
    'READYWORK_S3_SECRET_ACCESS_KEY',
  ]);
  const allowInsecureEndpoint = parseBoolean('READYWORK_S3_ALLOW_INSECURE_ENDPOINT', env['READYWORK_S3_ALLOW_INSECURE_ENDPOINT'], false);
  const endpoint = required['READYWORK_S3_ENDPOINT']!;
  let parsedEndpoint: URL;
  try { parsedEndpoint = new URL(endpoint); }
  catch { throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', 'READYWORK_S3_ENDPOINT 不是有效 URL'); }
  if (!['https:', 'http:'].includes(parsedEndpoint.protocol) || parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', 'READYWORK_S3_ENDPOINT 必须是无凭据、查询参数和片段的 http(s) URL');
  }
  if (parsedEndpoint.protocol !== 'https:' && !allowInsecureEndpoint) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', '明文对象存储端点已拒绝；仅本地 MinIO 可显式设置 READYWORK_S3_ALLOW_INSECURE_ENDPOINT=1');
  }
  const encryptionValue = (env['READYWORK_S3_SERVER_SIDE_ENCRYPTION'] ?? 'AES256').trim();
  if (encryptionValue !== 'AES256' && encryptionValue !== 'aws:kms') {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', 'READYWORK_S3_SERVER_SIDE_ENCRYPTION 必须为 AES256 或 aws:kms');
  }
  if (encryptionValue === 'aws:kms' && !env['READYWORK_S3_KMS_KEY_ID']?.trim()) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', '使用 aws:kms 时必须配置 READYWORK_S3_KMS_KEY_ID');
  }
  return {
    endpoint: parsedEndpoint.toString(),
    region: required['READYWORK_S3_REGION']!,
    bucket: required['READYWORK_S3_BUCKET']!,
    accessKeyId: required['READYWORK_S3_ACCESS_KEY_ID']!,
    secretAccessKey: required['READYWORK_S3_SECRET_ACCESS_KEY']!,
    ...(env['READYWORK_S3_SESSION_TOKEN']?.trim() ? { sessionToken: env['READYWORK_S3_SESSION_TOKEN'].trim() } : {}),
    forcePathStyle: parseBoolean('READYWORK_S3_FORCE_PATH_STYLE', env['READYWORK_S3_FORCE_PATH_STYLE'], true),
    serverSideEncryption: encryptionValue,
    ...(env['READYWORK_S3_KMS_KEY_ID']?.trim() ? { kmsKeyId: env['READYWORK_S3_KMS_KEY_ID'].trim() } : {}),
    signedGetTtlSeconds: parseBoundedInteger('READYWORK_S3_SIGNED_GET_TTL_SECONDS', env['READYWORK_S3_SIGNED_GET_TTL_SECONDS'], DEFAULT_SIGNED_URL_TTL_SECONDS, 1, MAX_SIGNED_URL_TTL_SECONDS),
    requestTimeoutMs: parseBoundedInteger('READYWORK_S3_REQUEST_TIMEOUT_MS', env['READYWORK_S3_REQUEST_TIMEOUT_MS'], 15_000, 1_000, 120_000),
    allowInsecureEndpoint,
  };
}

function validateS3Config(config: S3AttachmentObjectStorageConfig): void {
  if (!config.region.trim() || !config.accessKeyId.trim() || !config.secretAccessKey) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', 'S3/MinIO region 或访问凭据未配置');
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(config.bucket) || config.bucket.includes('..')) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', 'S3/MinIO bucket 名称无效');
  }
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); }
  catch { throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', 'S3/MinIO endpoint 无效'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', 'S3/MinIO endpoint 必须是安全的 http(s) URL');
  }
  if (endpoint.protocol === 'http:' && !config.allowInsecureEndpoint) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', 'S3/MinIO 明文 endpoint 未获准');
  }
  if ((config.serverSideEncryption ?? 'AES256') === 'aws:kms' && !config.kmsKeyId) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', 'aws:kms 缺少 KMS key id');
  }
  const ttl = config.signedGetTtlSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > MAX_SIGNED_URL_TTL_SECONDS) {
    throw new AttachmentObjectStorageError('CONFIGURATION_ERROR', `签名 URL 有效期必须为 1-${MAX_SIGNED_URL_TTL_SECONDS} 秒`);
  }
}

function stripQuotes(value: string | null): string | undefined {
  return value ? value.replace(/^"|"$/gu, '') : undefined;
}

/** S3/MinIO-compatible production attachment object storage using AWS SigV4. */
export class S3AttachmentObjectStorage implements AttachmentObjectStorage {
  readonly requestTimeoutMs: number;
  readonly #config: Required<Pick<S3AttachmentObjectStorageConfig, 'endpoint' | 'region' | 'bucket' | 'accessKeyId' | 'secretAccessKey' | 'forcePathStyle' | 'serverSideEncryption' | 'signedGetTtlSeconds' | 'requestTimeoutMs'>> & Pick<S3AttachmentObjectStorageConfig, 'sessionToken' | 'kmsKeyId'>;
  readonly #fetch: ObjectStorageFetch;
  readonly #now: () => Date;

  constructor(config: S3AttachmentObjectStorageConfig, options: S3AttachmentObjectStorageOptions = {}) {
    validateS3Config(config);
    this.#config = {
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      forcePathStyle: config.forcePathStyle ?? true,
      serverSideEncryption: config.serverSideEncryption ?? 'AES256',
      signedGetTtlSeconds: config.signedGetTtlSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS,
      requestTimeoutMs: config.requestTimeoutMs ?? 15_000,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
      ...(config.kmsKeyId ? { kmsKeyId: config.kmsKeyId } : {}),
    };
    this.requestTimeoutMs = this.#config.requestTimeoutMs;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async put(input: PutAttachmentObjectInput): Promise<AttachmentObjectMetadata> {
    assertIdentity(input);
    assertIntegrity(input);
    assertContentType(input.contentType);
    verifyBody(input, input.body);
    const key = attachmentObjectKey(input);
    const headers: Record<string, string> = {
      'content-type': input.contentType,
      'x-amz-meta-readywork-sha256': input.sha256,
      'x-amz-meta-readywork-size': String(input.sizeBytes),
      'x-amz-server-side-encryption': this.#config.serverSideEncryption,
    };
    if (this.#config.serverSideEncryption === 'aws:kms' && this.#config.kmsKeyId) {
      headers['x-amz-server-side-encryption-aws-kms-key-id'] = this.#config.kmsKeyId;
    }
    const response = await this.request('PUT', key, input.sha256, headers, Buffer.from(input.body));
    return {
      tenantId: input.tenantId,
      attachmentId: input.attachmentId,
      version: input.version,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      key,
      contentType: input.contentType,
      serverSideEncryption: this.#config.serverSideEncryption,
      ...(stripQuotes(response.headers.get('etag')) ? { etag: stripQuotes(response.headers.get('etag'))! } : {}),
      ...(response.headers.get('x-amz-version-id') ? { storageVersionId: response.headers.get('x-amz-version-id')! } : {}),
    };
  }

  async get(input: AttachmentObjectIntegrity): Promise<AttachmentObjectValue> {
    assertIdentity(input);
    assertIntegrity(input);
    const key = attachmentObjectKey(input);
    const response = await this.request('GET', key, EMPTY_SHA256);
    const body = new Uint8Array(await response.arrayBuffer());
    const metadata = this.metadataFromResponse(input, key, response);
    verifyBody(input, body);
    return { body, metadata };
  }

  async delete(input: AttachmentObjectIdentity): Promise<void> {
    assertIdentity(input);
    await this.request('DELETE', attachmentObjectKey(input), EMPTY_SHA256);
  }

  async head(input: AttachmentObjectIntegrity): Promise<AttachmentObjectMetadata | null> {
    assertIdentity(input);
    assertIntegrity(input);
    const key = attachmentObjectKey(input);
    const response = await this.request('HEAD', key, EMPTY_SHA256, {}, undefined, true);
    if (response.status === 404) return null;
    return this.metadataFromResponse(input, key, response);
  }

  async createSignedGetUrl(input: AttachmentObjectIntegrity & { readonly expiresInSeconds?: number }): Promise<SignedAttachmentObjectUrl> {
    const existing = await this.head(input);
    if (!existing) throw new AttachmentObjectStorageError('NOT_FOUND', '附件对象不存在', 404);
    const expiresInSeconds = input.expiresInSeconds ?? this.#config.signedGetTtlSeconds;
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
      throw new AttachmentObjectStorageError('INVALID_INPUT', `签名 URL 有效期必须为 1-${MAX_SIGNED_URL_TTL_SECONDS} 秒`);
    }
    const now = this.#now();
    const { dateTime, date } = amzDates(now);
    const key = attachmentObjectKey(input);
    const url = this.objectUrl(key);
    const scope = `${date}/${this.#config.region}/s3/aws4_request`;
    const query: Array<readonly [string, string]> = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.#config.accessKeyId}/${scope}`],
      ['X-Amz-Date', dateTime],
      ['X-Amz-Expires', String(expiresInSeconds)],
      ['X-Amz-SignedHeaders', 'host'],
    ];
    if (this.#config.sessionToken) query.push(['X-Amz-Security-Token', this.#config.sessionToken]);
    const normalizedQuery = canonicalQuery(query);
    const canonicalRequest = `GET\n${url.pathname}\n${normalizedQuery}\nhost:${url.host}\n\nhost\nUNSIGNED-PAYLOAD`;
    const stringToSign = `AWS4-HMAC-SHA256\n${dateTime}\n${scope}\n${sha256(canonicalRequest)}`;
    query.push(['X-Amz-Signature', signature(this.#config.secretAccessKey, date, this.#config.region, stringToSign)]);
    url.search = canonicalQuery(query);
    return { url: url.toString(), expiresAt: new Date(now.getTime() + expiresInSeconds * 1_000).toISOString() };
  }

  private metadataFromResponse(input: AttachmentObjectIntegrity, key: string, response: Response): AttachmentObjectMetadata {
    const sizeHeader = response.headers.get('content-length') ?? response.headers.get('x-amz-meta-readywork-size');
    const sizeBytes = sizeHeader === null ? Number.NaN : Number(sizeHeader);
    const objectSha256 = response.headers.get('x-amz-meta-readywork-sha256');
    verifyMetadata(input, sizeBytes, objectSha256);
    return {
      ...input,
      key,
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      ...(response.headers.get('x-amz-server-side-encryption') === 'AES256' || response.headers.get('x-amz-server-side-encryption') === 'aws:kms'
        ? { serverSideEncryption: response.headers.get('x-amz-server-side-encryption') as S3ServerSideEncryption }
        : {}),
      ...(stripQuotes(response.headers.get('etag')) ? { etag: stripQuotes(response.headers.get('etag'))! } : {}),
      ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}),
      ...(response.headers.get('x-amz-version-id') ? { storageVersionId: response.headers.get('x-amz-version-id')! } : {}),
    };
  }

  private objectUrl(key: string): URL {
    const endpoint = new URL(this.#config.endpoint);
    const base = endpoint.pathname.replace(/\/+$/u, '');
    const keyPath = key.split('/').map(percentEncode).join('/');
    if (this.#config.forcePathStyle) {
      endpoint.pathname = `${base}/${percentEncode(this.#config.bucket)}/${keyPath}`;
    } else {
      endpoint.hostname = `${this.#config.bucket}.${endpoint.hostname}`;
      endpoint.pathname = `${base}/${keyPath}`;
    }
    return endpoint;
  }

  private async request(
    method: 'PUT' | 'GET' | 'HEAD' | 'DELETE',
    key: string,
    payloadHash: string,
    headers: Record<string, string> = {},
    body?: ObjectStorageRequestBody,
    allowNotFound = false,
  ): Promise<Response> {
    const now = this.#now();
    const { dateTime, date } = amzDates(now);
    const url = this.objectUrl(key);
    const signingHeaders: Record<string, string> = {
      host: url.host,
      ...headers,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': dateTime,
      ...(this.#config.sessionToken ? { 'x-amz-security-token': this.#config.sessionToken } : {}),
    };
    const headerNames = Object.keys(signingHeaders).map((name) => name.toLowerCase()).sort();
    const canonicalHeaders = headerNames.map((name) => `${name}:${normalizedHeaderValue(signingHeaders[name]!)}`).join('\n');
    const signedHeaders = headerNames.join(';');
    const canonicalRequest = `${method}\n${url.pathname}\n\n${canonicalHeaders}\n\n${signedHeaders}\n${payloadHash}`;
    const scope = `${date}/${this.#config.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${dateTime}\n${scope}\n${sha256(canonicalRequest)}`;
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.#config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature(this.#config.secretAccessKey, date, this.#config.region, stringToSign)}`;
    const outgoingHeaders = new Headers({ ...headers, 'x-amz-content-sha256': payloadHash, 'x-amz-date': dateTime, authorization });
    if (this.#config.sessionToken) outgoingHeaders.set('x-amz-security-token', this.#config.sessionToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, { method, headers: outgoingHeaders, ...(body === undefined ? {} : { body }), signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new AttachmentObjectStorageError('REQUEST_TIMEOUT', `对象存储 ${method} 请求超时`);
      throw new AttachmentObjectStorageError('REMOTE_ERROR', `对象存储 ${method} 请求失败`);
    } finally {
      clearTimeout(timer);
    }
    if ((response.status >= 200 && response.status < 300) || (allowNotFound && response.status === 404)) return response;
    if (response.status === 404) throw new AttachmentObjectStorageError('NOT_FOUND', '附件对象不存在', 404);
    throw new AttachmentObjectStorageError('REMOTE_ERROR', `对象存储 ${method} 返回 HTTP ${response.status}`, response.status);
  }
}

/** In-process adapter for isolated tests. Do not select it in production configuration. */
export class MemoryAttachmentObjectStorage implements AttachmentObjectStorage {
  readonly #objects = new Map<string, AttachmentObjectValue>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async put(input: PutAttachmentObjectInput): Promise<AttachmentObjectMetadata> {
    assertIdentity(input);
    assertIntegrity(input);
    assertContentType(input.contentType);
    verifyBody(input, input.body);
    const key = attachmentObjectKey(input);
    const metadata: AttachmentObjectMetadata = { tenantId: input.tenantId, attachmentId: input.attachmentId, version: input.version, sha256: input.sha256, sizeBytes: input.sizeBytes, contentType: input.contentType, key };
    this.#objects.set(key, { body: input.body.slice(), metadata });
    return { ...metadata };
  }

  async get(input: AttachmentObjectIntegrity): Promise<AttachmentObjectValue> {
    assertIdentity(input);
    assertIntegrity(input);
    const stored = this.#objects.get(attachmentObjectKey(input));
    if (!stored) throw new AttachmentObjectStorageError('NOT_FOUND', '附件对象不存在', 404);
    verifyMetadata(input, stored.metadata.sizeBytes, stored.metadata.sha256);
    verifyBody(input, stored.body);
    return { body: stored.body.slice(), metadata: { ...stored.metadata } };
  }

  async delete(input: AttachmentObjectIdentity): Promise<void> {
    assertIdentity(input);
    this.#objects.delete(attachmentObjectKey(input));
  }

  async head(input: AttachmentObjectIntegrity): Promise<AttachmentObjectMetadata | null> {
    assertIdentity(input);
    assertIntegrity(input);
    const stored = this.#objects.get(attachmentObjectKey(input));
    if (!stored) return null;
    verifyMetadata(input, stored.metadata.sizeBytes, stored.metadata.sha256);
    return { ...stored.metadata };
  }

  async createSignedGetUrl(input: AttachmentObjectIntegrity & { readonly expiresInSeconds?: number }): Promise<SignedAttachmentObjectUrl> {
    const existing = await this.head(input);
    if (!existing) throw new AttachmentObjectStorageError('NOT_FOUND', '附件对象不存在', 404);
    const expiresInSeconds = input.expiresInSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
      throw new AttachmentObjectStorageError('INVALID_INPUT', `签名 URL 有效期必须为 1-${MAX_SIGNED_URL_TTL_SECONDS} 秒`);
    }
    const now = this.#now();
    return {
      url: `memory://attachment/${attachmentObjectKey(input)}?expires=${Math.floor(now.getTime() / 1_000) + expiresInSeconds}`,
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1_000).toISOString(),
    };
  }
}
