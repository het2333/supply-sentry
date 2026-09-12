import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  can,
  clearSessionCookieHeader,
  localDemoSession,
  login,
  logout,
  resolveSession,
  sessionCookieHeader,
  sessionTokenFromCookie,
} from '../src/auth.js';

function withDemoAuth(testFn: () => void): void {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDemoAuth = process.env.READYWORK_DEMO_AUTH;
  const originalDemoAccounts = process.env.READYWORK_ENABLE_DEMO_ACCOUNTS;
  const originalAnonymousAuth = process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH;
  process.env.NODE_ENV = 'test';
  process.env.READYWORK_DEMO_AUTH = '1';
  delete process.env.READYWORK_ENABLE_DEMO_ACCOUNTS;
  delete process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH;
  try {
    testFn();
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDemoAuth === undefined) delete process.env.READYWORK_DEMO_AUTH;
    else process.env.READYWORK_DEMO_AUTH = originalDemoAuth;
    if (originalDemoAccounts === undefined) delete process.env.READYWORK_ENABLE_DEMO_ACCOUNTS;
    else process.env.READYWORK_ENABLE_DEMO_ACCOUNTS = originalDemoAccounts;
    if (originalAnonymousAuth === undefined) delete process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH;
    else process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH = originalAnonymousAuth;
  }
}

test('鉴权: 演示账户与匿名本地管理员默认关闭', () => {
  const originalDemoAuth = process.env.READYWORK_DEMO_AUTH;
  const originalDemoAccounts = process.env.READYWORK_ENABLE_DEMO_ACCOUNTS;
  const originalAnonymousAuth = process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH;
  delete process.env.READYWORK_DEMO_AUTH;
  delete process.env.READYWORK_ENABLE_DEMO_ACCOUNTS;
  delete process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH;
  try {
    assert.equal(login('admin', 'admin123'), null);
    assert.equal(localDemoSession(), null);
  } finally {
    if (originalDemoAuth === undefined) delete process.env.READYWORK_DEMO_AUTH;
    else process.env.READYWORK_DEMO_AUTH = originalDemoAuth;
    if (originalDemoAccounts === undefined) delete process.env.READYWORK_ENABLE_DEMO_ACCOUNTS;
    else process.env.READYWORK_ENABLE_DEMO_ACCOUNTS = originalDemoAccounts;
    if (originalAnonymousAuth === undefined) delete process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH;
    else process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH = originalAnonymousAuth;
  }
});

test('鉴权: 演示账户与匿名本地管理员使用独立开关，生产环境始终拒绝', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDemoAuth = process.env.READYWORK_DEMO_AUTH;
  const originalAnonymousAuth = process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH;
  try {
    process.env.NODE_ENV = 'test';
    process.env.READYWORK_DEMO_AUTH = '1';
    assert.ok(login('admin', 'admin123'));
    assert.equal(localDemoSession(), null);
    process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH = '1';
    assert.equal(localDemoSession()?.role, '管理员');
    process.env.NODE_ENV = 'production';
    assert.equal(login('admin', 'admin123'), null);
    assert.equal(localDemoSession(), null);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalDemoAuth === undefined) delete process.env.READYWORK_DEMO_AUTH;
    else process.env.READYWORK_DEMO_AUTH = originalDemoAuth;
    if (originalAnonymousAuth === undefined) delete process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH;
    else process.env.READYWORK_ENABLE_LOCAL_ANONYMOUS_AUTH = originalAnonymousAuth;
  }
});

test('鉴权: 密码哈希登录并签发带租户的签名会话', () => {
  withDemoAuth(() => {
    const result = login('manager', 'manager123');
    assert.ok(result);
    assert.equal(result.session.tenantId, 't:acme');
    assert.equal(resolveSession(result.token)?.humanId, 'h:procurement-manager');
    assert.equal(login('manager', 'wrong-password'), null);
  });
});

test('鉴权: 篡改或撤销后的令牌不可使用', () => {
  withDemoAuth(() => {
    const result = login('admin', 'admin123');
    assert.ok(result);
    const parts = result.token.split('.');
    const tampered = `${parts[0]}.${parts[1]}x.${parts[2]}`;
    assert.equal(resolveSession(tampered), null);
    logout(result.token);
    assert.equal(resolveSession(result.token), null);
  });
});

test('鉴权: RBAC 区分操作、审批、配置与管理权限', () => {
  withDemoAuth(() => {
    const buyer = login('buyer', 'buyer123')?.session;
    const manager = login('manager', 'manager123')?.session;
    const admin = login('admin', 'admin123')?.session;
    assert.ok(buyer && manager && admin);
    assert.equal(can(buyer, 'operate'), true);
    assert.equal(can(buyer, 'approve'), false);
    assert.equal(can(manager, 'configure'), true);
    assert.equal(can(manager, 'admin'), false);
    assert.equal(can(admin, 'admin'), true);
  });
});

test('鉴权: Web 会话使用 HttpOnly SameSite Cookie 并可安全清除', () => {
  withDemoAuth(() => {
    const result = login('manager', 'manager123');
    assert.ok(result);
    const localCookie = sessionCookieHeader(result.token, false);
    assert.match(localCookie, /^readywork_session=rw1\./);
    assert.match(localCookie, /; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    assert.doesNotMatch(localCookie, /; Secure$/);
    assert.equal(sessionTokenFromCookie(`theme=light; ${localCookie.split(';')[0]}; locale=zh-CN`), result.token);
    const cookieToken = sessionTokenFromCookie(localCookie);
    assert.ok(cookieToken);
    assert.deepEqual(resolveSession(cookieToken), result.session);
    assert.match(sessionCookieHeader(result.token, true), /; Secure$/);
    assert.equal(clearSessionCookieHeader(false), 'readywork_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    assert.match(clearSessionCookieHeader(true), /; Secure$/);
    assert.equal(sessionTokenFromCookie('theme=light; empty='), undefined);
  });
});
