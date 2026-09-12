import type { DatabaseSync } from 'node:sqlite';
import {
  CORE_WORKFORCE_EDITOR_PACK,
  EditorStore,
  PROCUREMENT_EDITOR_PACK,
  type EditorCapabilityPack,
} from './editor.js';

export interface EditorScope {
  tenantId: string;
  employeeId: string;
}

export function editorPackForCapabilityPackIds(capabilityPackIds: readonly string[]): EditorCapabilityPack {
  if (capabilityPackIds.includes('capability:procurement')) return PROCUREMENT_EDITOR_PACK;
  return CORE_WORKFORCE_EDITOR_PACK;
}

/**
 * EditorStoreRegistry 是控制面的员工隔离入口。
 * 每个 tenant/employee 拥有独立草稿、版本、规则与运行记录。
 */
export class EditorStoreRegistry {
  private stores = new Map<string, EditorStore>();

  constructor(
    private db?: DatabaseSync,
    private resolveCapabilityPackIds: (scope: EditorScope) => readonly string[] = () => ['capability:workforce-core'],
  ) {}

  forScope(scope: EditorScope): EditorStore {
    const key = `${scope.tenantId}\u0000${scope.employeeId}`;
    let store = this.stores.get(key);
    if (!store) {
      store = new EditorStore(this.db, scope, editorPackForCapabilityPackIds(this.resolveCapabilityPackIds(scope)));
      this.stores.set(key, store);
    }
    return store;
  }

  forRun(runId: string, fallback: EditorScope): EditorStore {
    if (this.db) {
      const row = this.db.prepare('SELECT tenant_id, employee_id FROM control_workflow_runs WHERE id = ? ORDER BY created_at DESC LIMIT 1').get(runId) as { tenant_id: string; employee_id: string } | undefined;
      if (row) return this.forScope({ tenantId: row.tenant_id, employeeId: row.employee_id });
    }
    for (const store of this.stores.values()) if (store.getRun(runId)) return store;
    return this.forScope(fallback);
  }
}
