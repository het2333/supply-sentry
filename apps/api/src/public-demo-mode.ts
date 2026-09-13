export const PUBLIC_DEMO_TENANT_ID = 't:public-demo' as const;

export interface PublicDemoCapabilities {
  demoMode: true;
  tenantId: typeof PUBLIC_DEMO_TENANT_ID;
  syntheticData: true;
  externalDelivery: false;
  uploads: false;
  credentialManagement: false;
}

/** Server-owned mode switch. Request data must never participate in this decision. */
export function publicDemoMode(): boolean {
  return process.env['READYWORK_PUBLIC_DEMO'] === '1';
}

/** Public demo starts only when both isolation invariants are explicit. */
export function assertPublicDemoConfiguration(): void {
  if (!publicDemoMode()) return;
  if (process.env['READYWORK_PUBLIC_DEMO_TENANT'] !== PUBLIC_DEMO_TENANT_ID) {
    throw new Error('Public demo tenant configuration is invalid');
  }
  if (process.env['READYWORK_PUBLIC_DEMO_SIMULATION_POLICY'] !== 'simulated_demo') {
    throw new Error('Public demo simulation policy is missing');
  }
}

export function publicDemoCapabilities(): PublicDemoCapabilities {
  assertPublicDemoConfiguration();
  return {
    demoMode: true,
    tenantId: PUBLIC_DEMO_TENANT_ID,
    syntheticData: true,
    externalDelivery: false,
    uploads: false,
    credentialManagement: false,
  };
}

/** Capability denial is evaluated before route dispatch or request-body reads. */
export function publicDemoCapabilityDenied(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (/^\/api\/(?:editor|operations)(?:\/|$)/u.test(path)) return true;
  if (/^\/api\/connectors\//u.test(path)) return true;
  if (/^\/api\/messaging\/onboarding\//u.test(path)) return true;
  if (normalizedMethod !== 'GET' && /^\/api\/messaging\/platforms\/[^/]+(?:\/test)?$/u.test(path)) return true;
  if (normalizedMethod === 'POST' && /^\/api\/procurement\/import-documents\/pos\/[^/]+\/documents$/u.test(path)) return true;
  if (normalizedMethod === 'POST' && /^\/api\/procurement\/routes\/[^/]+\/exports$/u.test(path)) return true;
  if (normalizedMethod === 'GET' && /^\/api\/procurement\/route-exports\/[^/]+\/download$/u.test(path)) return true;
  return false;
}
