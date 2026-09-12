export type ApiSurface = 'compat' | 'business' | 'control';
export type RouteDomain = 'shared' | 'business' | 'control';

/** 部署边界白名单：即使误把进程暴露出去，也不会跨面提供路由。 */
export function routeDomain(method: string, path: string): RouteDomain {
  if (path === '/' || path === '/health' || path.startsWith('/api/auth/')) return 'shared';
  if (method === 'GET' && (path === '/api/employees' || /^\/api\/employees\/[^/]+$/.test(path))) return 'shared';
  if (path.startsWith('/api/internal/') || path.startsWith('/api/editor/') || path === '/api/editor' || path.startsWith('/api/rules') || path === '/api/catalog' || path === '/api/employee-packs' || path.startsWith('/api/employee-packs/') || path.startsWith('/api/operations/') || path === '/api/collaboration/teams/bindings') return 'control';
  if (method !== 'GET' && (path.startsWith('/api/employees') || path.startsWith('/api/connectors/'))) return 'control';
  return 'business';
}

export function surfaceAllows(surface: ApiSurface, method: string, path: string): boolean {
  if (surface === 'compat') return true;
  const domain = routeDomain(method, path);
  return domain === 'shared' || domain === surface;
}
