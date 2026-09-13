import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { assertPublicDemoConfiguration, PUBLIC_DEMO_TENANT_ID } from './public-demo-mode.js';

export type PlatformPermission = 'read' | 'operate' | 'approve' | 'configure' | 'admin';

export interface Account {
  username: string;
  passwordSalt: string;
  passwordHash: string;
  tenantId: string;
  humanId: string;
  name: string;
  role: string;
}

export interface Session {
  username: string;
  tenantId: string;
  humanId: string;
  name: string;
  role: string;
  expiresAt: number;
}

/** 本地演示账户只保存 scrypt 哈希；生产环境应由 SSO/LDAP 注入身份。 */
export const ACCOUNTS: Account[] = [
  { username: 'admin', passwordSalt: 'readywork-demo-admin', passwordHash: 'a3ec208915f15fd5cda1f50f738af2fd4a2f235a8a703145224722c45e3427d1', tenantId: 't:acme', humanId: 'h:procurement-manager', name: '管理员', role: '管理员' },
  { username: 'manager', passwordSalt: 'readywork-demo-manager', passwordHash: 'f5361117fee7d75908c410411b11e9a28d8a9c84af5d67c58b1ae7f8ef0d462c', tenantId: 't:acme', humanId: 'h:procurement-manager', name: '王经理', role: '采购经理' },
  { username: 'buyer', passwordSalt: 'readywork-demo-buyer', passwordHash: '20a2e1cd700db0ca0c3d928261a47e6c4ff34c9931b219097a444015f3ef20d4', tenantId: 't:acme', humanId: 'h:buyer-1', name: '李采购', role: '采购专员' },
  { username: 'sales', passwordSalt: 'readywork-demo-sales', passwordHash: 'a83a97473678d1b0e3e11f01e75f716906be0d6fdf31228bb556b9f1da3b32b2', tenantId: 't:acme', humanId: 'h:sales-manager', name: '陈经理', role: '销售经理' },
];

const TTL_MS = 12 * 3600_000;
const revoked = new Set<string>();
const sessionSecret = process.env['READYWORK_SESSION_SECRET'] ?? (process.env['NODE_ENV'] === 'production' ? '' : 'readywork-local-session-secret-change-in-production');
export const SESSION_COOKIE_NAME = 'readywork_session';

/**
 * 演示身份必须显式开启。仅凭“请求来自 loopback”并不可信：反向代理、开发
 * 服务器 rewrite 和容器网络都会让远端用户的请求以 127.0.0.1 到达 API。
 */
export function demoAuthEnabled(): boolean {
  return process.env['NODE_ENV'] !== 'production'
    && (process.env['READYWORK_DEMO_AUTH'] === '1' || process.env['READYWORK_ENABLE_DEMO_ACCOUNTS'] === '1');
}

function localAnonymousAuthEnabled(): boolean {
  return demoAuthEnabled() && process.env['READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH'] === '1';
}

/**
 * Web 会话只进入 HttpOnly Cookie；浏览器 JavaScript 不读取或持久化签名令牌。
 * SameSite=Lax 与 API Origin allowlist 共同收紧跨站请求，生产环境强制 Secure。
 */
export function sessionCookieHeader(token: string, secure: boolean): string {
  const secureAttribute = secure ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(TTL_MS / 1000)}${secureAttribute}`;
}

export function clearSessionCookieHeader(secure: boolean): string {
  const secureAttribute = secure ? '; Secure' : '';
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute}`;
}

export function sessionTokenFromCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}

const ROLE_PERMISSIONS: Record<string, Set<PlatformPermission>> = {
  管理员: new Set(['read', 'operate', 'approve', 'configure', 'admin']),
  采购经理: new Set(['read', 'operate', 'approve', 'configure']),
  销售经理: new Set(['read', 'operate', 'approve', 'configure']),
  采购专员: new Set(['read', 'operate']),
  审计员: new Set(['read']),
};

function signature(payload: string): string {
  if (!sessionSecret) throw new Error('生产环境必须配置 READYWORK_SESSION_SECRET');
  return createHmac('sha256', sessionSecret).update(payload).digest('base64url');
}

function passwordMatches(account: Account, password: string): boolean {
  const actual = scryptSync(password, account.passwordSalt, 32);
  const expected = Buffer.from(account.passwordHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function signSession(session: Session): { token: string; session: Session } {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return { token: `rw1.${payload}.${signature(payload)}`, session };
}

export function login(username: string, password: string): { token: string; session: Session } | null {
  if (!demoAuthEnabled()) return null;
  const account = ACCOUNTS.find((item) => item.username === username);
  if (!account || !passwordMatches(account, password)) return null;
  const session: Session = { username: account.username, tenantId: account.tenantId, humanId: account.humanId, name: account.name, role: account.role, expiresAt: Date.now() + TTL_MS };
  return signSession(session);
}

export function createPublicDemoSession(now = Date.now()): { token: string; session: Session } {
  assertPublicDemoConfiguration();
  return signSession({
    username: 'public-demo',
    tenantId: PUBLIC_DEMO_TENANT_ID,
    humanId: 'h:public-demo-manager',
    name: '公开演示采购经理',
    role: '采购经理',
    expiresAt: now + TTL_MS,
  });
}

export function logout(token: string): void {
  if (token) revoked.add(token);
}

export function resolveSession(token: string): Session | null {
  if (!token || revoked.has(token)) return null;
  const [version, payload, candidate] = token.split('.');
  if (version !== 'rw1' || !payload || !candidate) return null;
  const expected = Buffer.from(signature(payload));
  const actual = Buffer.from(candidate);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
    return session.expiresAt > Date.now() && Boolean(session.tenantId) ? session : null;
  } catch {
    return null;
  }
}

export function can(session: Session | null, permission: PlatformPermission): boolean {
  return Boolean(session && ROLE_PERMISSIONS[session.role]?.has(permission));
}

/**
 * 匿名本地管理员是单独的高风险兼容开关：仅启用演示账户并不会开启。
 * 正常本机验收应经过 Web 登录并使用 HttpOnly 会话。
 */
export function localDemoSession(): Session | null {
  if (!localAnonymousAuthEnabled()) return null;
  return { username: 'local-demo', tenantId: 't:acme', humanId: 'h:procurement-manager', name: '本地管理员', role: '管理员', expiresAt: Date.now() + TTL_MS };
}
