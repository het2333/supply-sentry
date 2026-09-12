import type { PermissionRule, PolicyRule, RuleContext } from './employee-spec.js';

/**
 * Policy Engine：
 * - 权限：默认拒绝；deny 优先；action/resource 支持 '*' 与 '前缀.*'
 * - 策略：when 命中时 block / require_approval
 */
export class PolicyEngine {
  can(rules: PermissionRule[], action: string, resource: string): boolean {
    const denies = rules.filter((r) => r.effect === 'deny' && this.matches(r, action, resource));
    if (denies.length > 0) return false;
    const allows = rules.filter((r) => r.effect === 'allow' && this.matches(r, action, resource));
    return allows.length > 0;
  }

  private matches(r: PermissionRule, action: string, resource: string): boolean {
    return matchPattern(r.action, action) && matchPattern(r.resource, resource);
  }

  evaluatePolicies(rules: PolicyRule[], ctx: RuleContext): PolicyRule[] {
    return rules.filter((r) => {
      try {
        return r.when(ctx);
      } catch {
        return false;
      }
    });
  }
}

export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*' || pattern === value) return true;
  if (pattern.endsWith('.*')) {
    const p = pattern.slice(0, -2);
    return value === p || value.startsWith(`${p}.`);
  }
  return false;
}
