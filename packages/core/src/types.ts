/** 基础领域类型 */
export type EntityId = string;
export type ISODateTime = string;
export type Month = string; // 'YYYY-MM'

export interface Money {
  amount: number;
  currency: string;
}

/** 事件选择器：用于 wait(forEvent) 恢复匹配 */
export interface EventSelector {
  eventType: string;
  objectId?: string;
  match?: Record<string, unknown>;
}

export function nowIso(): ISODateTime {
  return new Date().toISOString();
}

export function uid(prefix: string): EntityId {
  return `${prefix}:${crypto.randomUUID().slice(0, 8)}`;
}

export function currentMonth(): Month {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
