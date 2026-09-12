import { sectionFromNavigationValue, type ReadyworkSection } from '../procurement/navigation-state';

export interface EmployeePackNavigationItemView {
  id: string;
  label: string;
  icon: string;
}

export interface EmployeePackNavigationGroupView {
  id: string;
  label: string;
  items: EmployeePackNavigationItemView[];
}

export interface EmployeePackManifestView {
  id: string;
  version: string;
  name: string;
  description: string;
  defaultEmployeeId?: string;
  branding: { productName: string; employeeSubtitle: string; workspaceLabel: string; themeId: string };
  interfaces: {
    business: {
      id: 'business';
      label: string;
      enabled: boolean;
      defaultSectionId: string;
      ownedSectionIds: string[];
      navigationGroups: EmployeePackNavigationGroupView[];
    };
    developer: {
      id: 'developer';
      label: string;
      enabled: boolean;
      defaultSectionId: string;
      ownedSectionIds: string[];
      navigationGroups: EmployeePackNavigationGroupView[];
    };
  };
  lifecycle?: {
    entityType: string;
    startStageId: string;
    terminalStageId: string;
    stages: Array<{
      id: string;
      label: string;
      description: string;
      workflowIds: string[];
    }>;
  };
}

export interface EmployeePackBindingView {
  manifest: EmployeePackManifestView;
  installed: boolean;
  employeeIds: string[];
}

export interface EmployeePackCatalogView {
  items: EmployeePackBindingView[];
}

export type EmployeePackViewMode = 'business' | 'developer';

/**
 * Developer surfaces are fail-closed. A plain or malformed Employee Pack URL
 * remains in business mode; only the explicit, shareable value may open the
 * workflow editor after refresh.
 */
export function employeePackViewModeFromNavigationValue(value: unknown): EmployeePackViewMode {
  return value === 'developer' ? 'developer' : 'business';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 控制面数据结构不完整时 fail closed，不生成虚假采购导航。 */
export function parseEmployeePackCatalog(value: unknown): EmployeePackCatalogView {
  if (!isRecord(value) || !Array.isArray(value['items'])) throw new Error('Employee Pack 清单格式无效');
  const items = value['items'].map((item, index) => {
    if (!isRecord(item) || !isRecord(item['manifest']) || !Array.isArray(item['employeeIds']) || typeof item['installed'] !== 'boolean') {
      throw new Error(`Employee Pack 绑定 ${index + 1} 格式无效`);
    }
    const manifest = item['manifest'];
    if (typeof manifest['id'] !== 'string' || typeof manifest['version'] !== 'string' || typeof manifest['name'] !== 'string'
      || typeof manifest['description'] !== 'string' || !isRecord(manifest['branding']) || !isRecord(manifest['interfaces'])) {
      throw new Error(`Employee Pack ${index + 1} Manifest 格式无效`);
    }
    const business = manifest['interfaces']['business'];
    const developer = manifest['interfaces']['developer'];
    if (!isRecord(business) || !isRecord(developer) || !Array.isArray(business['ownedSectionIds']) || !Array.isArray(business['navigationGroups'])) {
      throw new Error(`Employee Pack ${manifest['id']} 界面合同格式无效`);
    }
    const lifecycle = manifest['lifecycle'];
    if (lifecycle !== undefined) {
      if (!isRecord(lifecycle) || typeof lifecycle['entityType'] !== 'string'
        || typeof lifecycle['startStageId'] !== 'string' || typeof lifecycle['terminalStageId'] !== 'string'
        || !Array.isArray(lifecycle['stages']) || lifecycle['stages'].length === 0) {
        throw new Error(`Employee Pack ${manifest['id']} 生命周期合同格式无效`);
      }
      for (const [stageIndex, stage] of lifecycle['stages'].entries()) {
        if (!isRecord(stage) || typeof stage['id'] !== 'string' || typeof stage['label'] !== 'string'
          || typeof stage['description'] !== 'string' || !Array.isArray(stage['workflowIds'])) {
          throw new Error(`Employee Pack ${manifest['id']} 生命周期阶段 ${stageIndex + 1} 格式无效`);
        }
      }
    }
    return item as unknown as EmployeePackBindingView;
  });
  return { items };
}

export function activeEmployeePack(catalog: EmployeePackCatalogView | null, employeeId: string): EmployeePackBindingView | null {
  if (!catalog) return null;
  return catalog.items.find((item) => item.employeeIds.includes(employeeId))
    ?? catalog.items.find((item) => item.installed)
    ?? null;
}

export function preferredEmployeeId(catalog: EmployeePackCatalogView, availableEmployeeIds: readonly string[]): string | null {
  const available = new Set(availableEmployeeIds);
  for (const item of catalog.items) {
    if (!item.installed) continue;
    if (item.manifest.defaultEmployeeId && available.has(item.manifest.defaultEmployeeId)) return item.manifest.defaultEmployeeId;
    const bound = item.employeeIds.find((employeeId) => available.has(employeeId));
    if (bound) return bound;
  }
  return availableEmployeeIds[0] ?? null;
}

export function buildEmployeePackNavigationGroups<T>(
  manifest: EmployeePackManifestView,
  icons: Readonly<Record<string, T>>,
): Array<{ id: string; label: string; items: Array<{ id: ReadyworkSection; label: string; icon: T }> }> {
  const seen = new Set<ReadyworkSection>();
  return manifest.interfaces.business.navigationGroups.map((group) => ({
    id: group.id,
    label: group.label,
    items: group.items.map((item) => {
      const section = sectionFromNavigationValue(item.id);
      if (!section || !manifest.interfaces.business.ownedSectionIds.includes(item.id)) throw new Error(`Employee Pack 导航包含未知入口: ${item.id}`);
      if (seen.has(section)) throw new Error(`Employee Pack 导航包含重复入口: ${item.id}`);
      seen.add(section);
      const icon = icons[item.icon];
      if (!icon) throw new Error(`Employee Pack 导航图标未注册: ${item.icon}`);
      return { id: section, label: item.label, icon };
    }),
  }));
}

/**
 * The installable manifest remains the authority for routes, labels and icons.
 * The procurement shell only rearranges those published items into the same
 * visual hierarchy as the reference application; it never creates navigation
 * entries or exposes owned deep links that the manifest keeps hidden.
 */
export function buildEmployeePackSidebarGroups<T>(
  manifest: EmployeePackManifestView,
  icons: Readonly<Record<string, T>>,
): Array<{ id: string; label: string; items: Array<{ id: ReadyworkSection; label: string; icon: T }> }> {
  const manifestGroups = buildEmployeePackNavigationGroups(manifest, icons);
  if (manifest.branding.themeId !== 'readywork-procurement') return manifestGroups;

  const manifestItems = manifestGroups.flatMap((group) => group.items);
  const itemsById = new Map(manifestItems.map((item) => [item.id, item] as const));
  const presentation = [
    { id: 'procurement-overview', label: '', itemIds: ['home'] },
    { id: 'procurement-communications', label: '', itemIds: ['notifications', 'message-drafts'] },
    { id: 'procurement-routes', label: '采购路径', itemIds: ['local-procurement', 'import-procurement'] },
    { id: 'procurement-reports', label: '报表', itemIds: ['risk-dashboard'] },
    { id: 'procurement-settings', label: '设置', itemIds: ['suppliers', 'sla', 'advanced-sla', 'settings'] },
  ] as const;
  const consumed = new Set<ReadyworkSection>();
  const sidebarGroups: Array<{ id: string; label: string; items: Array<{ id: ReadyworkSection; label: string; icon: T }> }> = presentation.map((group) => ({
    id: group.id,
    label: group.label,
    items: group.itemIds.flatMap((itemId) => {
      const item = itemsById.get(itemId as ReadyworkSection);
      if (!item) return [];
      consumed.add(item.id);
      return [item];
    }),
  })).filter((group) => group.items.length > 0);
  const ungroupedItems = manifestItems.filter((item) => !consumed.has(item.id));
  if (ungroupedItems.length > 0) sidebarGroups.push({ id: 'procurement-other', label: '', items: ungroupedItems });
  return sidebarGroups;
}

/**
 * Deep links are part of the Employee Pack contract too. A stale bookmark must
 * not reopen a page owned by a different/future employee merely because that
 * component still exists in the monorepo.
 */
export function resolveEmployeePackSection(
  manifest: EmployeePackManifestView,
  requested: ReadyworkSection,
  viewMode: EmployeePackViewMode,
): { section: ReadyworkSection; redirected: boolean } {
  const businessOwned = manifest.interfaces.business.enabled
    && manifest.interfaces.business.ownedSectionIds.includes(requested);
  const developerOwned = viewMode === 'developer'
    && manifest.interfaces.developer.enabled
    && manifest.interfaces.developer.ownedSectionIds.includes(requested);
  if (businessOwned || developerOwned) return { section: requested, redirected: false };

  const fallback = sectionFromNavigationValue(manifest.interfaces.business.defaultSectionId) ?? 'home';
  return { section: fallback, redirected: true };
}
