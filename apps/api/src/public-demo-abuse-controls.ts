import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { PUBLIC_DEMO_TENANT_ID } from './public-demo-mode.js';

export type PublicDemoRateBucket = 'entry' | 'mutation' | 'search' | 'chat' | 'read';

export type RateLimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: 'DEMO_RATE_LIMITED'; readonly retryAfterSeconds: number };

export interface PublicDemoRateLimitInput {
  readonly ip: string | undefined;
  readonly username: string | undefined;
  readonly method: string;
  readonly path: string;
}

interface RateBucketState {
  remaining: number;
  resetAt: number;
  touchedAt: number;
}

const WINDOW_MS = 60_000;
const DEFAULT_MAX_KEYS = 10_000;
const LIMITS: Readonly<Record<PublicDemoRateBucket, number>> = {
  entry: 10,
  mutation: 120,
  search: 60,
  chat: 20,
  read: 120,
};

const CHAT_PATHS = new Set(['/api/po/chat', '/api/procurement/route-chat']);
const MAX_JSON_BODY_BYTES = 1_048_576;
const MAX_ROUTE_CHAT_JSON_BYTES = 256 * 1024;

export function classifyPublicDemoRequest(method: string, path: string): PublicDemoRateBucket | null {
  const normalizedMethod = method.toUpperCase();
  if (path === '/internal/demo/reset' || path === '/health' || path === '/') return null;
  if (normalizedMethod === 'POST' && (path === '/api/auth/public-demo' || path === '/api/auth/login')) return 'entry';
  if (CHAT_PATHS.has(path)) return 'chat';
  if (normalizedMethod === 'GET' && path === '/api/procurement/search') return 'search';
  if (!path.startsWith('/api/')) return null;
  if (normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD' && normalizedMethod !== 'OPTIONS') return 'mutation';
  return 'read';
}

/** A zero limit means the body format is disabled before any bytes are read. */
export function publicDemoRequestBodyLimit(method: string, path: string, contentType: string | undefined): number | null {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === 'GET' || normalizedMethod === 'HEAD' || normalizedMethod === 'OPTIONS') return null;
  if (/^multipart\/form-data(?:;|$)/iu.test(contentType?.trim() ?? '')) return 0;
  return CHAT_PATHS.has(path) ? MAX_ROUTE_CHAT_JSON_BYTES : MAX_JSON_BODY_BYTES;
}

function normalizedIp(value: string | undefined): string {
  const first = value?.split(',')[0]?.trim().toLowerCase();
  if (!first) return 'unknown';
  return first.startsWith('::ffff:') ? first.slice('::ffff:'.length) : first;
}

function identityDigest(input: PublicDemoRateLimitInput, bucket: PublicDemoRateBucket): string {
  return createHash('sha256')
    .update(`${normalizedIp(input.ip)}\u0000${input.username?.trim().toLowerCase() || 'anonymous'}\u0000${bucket}`)
    .digest('base64url');
}

export class PublicDemoRateLimiter {
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, RateBucketState>();

  constructor(options: { readonly now?: () => number; readonly maxKeys?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxKeys = Math.max(100, options.maxKeys ?? DEFAULT_MAX_KEYS);
  }

  check(input: PublicDemoRateLimitInput): RateLimitDecision {
    const bucket = classifyPublicDemoRequest(input.method, input.path);
    if (!bucket) return { allowed: true };
    const now = this.#now();
    const key = identityDigest(input, bucket);
    let state = this.#buckets.get(key);
    if (!state || now >= state.resetAt) {
      state = { remaining: LIMITS[bucket], resetAt: now + WINDOW_MS, touchedAt: now };
      this.#buckets.set(key, state);
      this.#evict(now);
    }
    state.touchedAt = now;
    if (state.remaining <= 0) {
      return {
        allowed: false,
        code: 'DEMO_RATE_LIMITED',
        retryAfterSeconds: Math.max(1, Math.ceil((state.resetAt - now) / 1000)),
      };
    }
    state.remaining -= 1;
    return { allowed: true };
  }

  #evict(now: number): void {
    if (this.#buckets.size <= this.#maxKeys) return;
    for (const [key, state] of this.#buckets) {
      if (now >= state.resetAt) this.#buckets.delete(key);
      if (this.#buckets.size <= this.#maxKeys) return;
    }
    const oldest = [...this.#buckets.entries()]
      .sort((left, right) => left[1].touchedAt - right[1].touchedAt)
      .slice(0, this.#buckets.size - this.#maxKeys);
    for (const [key] of oldest) this.#buckets.delete(key);
  }
}

export class PublicDemoGenerationConflictError extends Error {
  readonly code = 'DEMO_GENERATION_CONFLICT' as const;

  constructor(readonly currentGeneration: number) {
    super('Public demo data was reset; refresh this view before changing it');
    this.name = 'PublicDemoGenerationConflictError';
  }
}

export function currentPublicDemoGeneration(db: DatabaseSync): number {
  const state = db.prepare(`SELECT generation FROM public_demo_state WHERE tenant_id=?`)
    .get(PUBLIC_DEMO_TENANT_ID) as { generation: number } | undefined;
  if (!state || !Number.isSafeInteger(state.generation) || state.generation < 1) {
    throw new Error('Public demo generation is unavailable');
  }
  return state.generation;
}

export function requireCurrentDemoGeneration(req: IncomingMessage, db: DatabaseSync): number {
  const currentGeneration = currentPublicDemoGeneration(db);
  const raw = req.headers['x-readywork-demo-generation'];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  if (!supplied || !/^\d+$/u.test(supplied) || Number(supplied) !== currentGeneration) {
    throw new PublicDemoGenerationConflictError(currentGeneration);
  }
  return currentGeneration;
}
