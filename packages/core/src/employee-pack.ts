export interface EmployeePackNavigationItem {
  id: string;
  label: string;
  icon: string;
}

export interface EmployeePackNavigationGroup {
  id: string;
  label: string;
  items: EmployeePackNavigationItem[];
}

export interface EmployeePackInterfaceDefinition {
  id: 'business' | 'developer';
  label: string;
  enabled: boolean;
  defaultSectionId: string;
  ownedSectionIds: string[];
  navigationGroups: EmployeePackNavigationGroup[];
}

export interface EmployeePackContextContract {
  entityTypes: string[];
}

export interface EmployeePackGovernanceContract {
  policyIds: string[];
  approvalRuleIds: string[];
  evalCriterionIds: string[];
}

export interface EmployeePackConnectorRequirement {
  connectorId: string;
  required: boolean;
  actionIds: string[];
}

export interface EmployeePackAssets {
  employeeSpecIds: string[];
  workerIds: string[];
  workflowIds: string[];
  skillIds: string[];
  toolIds: string[];
  nodeTypeIds: string[];
}

export interface EmployeePackLifecycleStage {
  id: string;
  label: string;
  description: string;
  workflowIds: string[];
}

/**
 * Employee Pack 对业务对象生命周期的可序列化声明。
 * 它描述产品负责的边界，不保存任何租户业务事实或当前运行状态。
 */
export interface EmployeePackLifecycleContract {
  entityType: string;
  startStageId: string;
  terminalStageId: string;
  stages: EmployeePackLifecycleStage[];
}

/**
 * Employee Pack 是可安装 AI 员工的权威、可序列化产品合同。
 * 它只声明产品资产与运行要求，不包含租户凭据或业务事实。
 */
export interface EmployeePackManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  defaultEmployeeId?: string;
  branding: {
    productName: string;
    employeeSubtitle: string;
    workspaceLabel: string;
    themeId: string;
  };
  assets: EmployeePackAssets;
  interfaces: {
    business: EmployeePackInterfaceDefinition;
    developer: EmployeePackInterfaceDefinition;
  };
  lifecycle?: EmployeePackLifecycleContract;
  context: EmployeePackContextContract;
  governance: EmployeePackGovernanceContract;
  connectors: EmployeePackConnectorRequirement[];
}

const PACK_ID = /^capability:[a-z0-9][a-z0-9._-]*$/;
const ASSET_ID = /^[a-z][A-Za-z0-9._:-]*$/;
const SECTION_ID = /^[a-z][a-z0-9-]*$/;
const ICON_ID = /^[a-z][a-z0-9-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function objectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须是对象`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${path} 包含未声明字段: ${unexpected.join(', ')}`);
}

function requiredString(value: unknown, path: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} 必须是非空字符串`);
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) throw new Error(`${path} 格式非法: ${normalized}`);
  return normalized;
}

function navigationGroupLabel(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} 必须是字符串`);
  return value.trim();
}

function uniqueStringArray(value: unknown, path: string, pattern = ASSET_ID): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组`);
  const result = value.map((item, index) => requiredString(item, `${path}[${index}]`, pattern));
  if (new Set(result).size !== result.length) throw new Error(`${path} 不能包含重复 ID`);
  return result;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateInterface(value: unknown, expectedId: EmployeePackInterfaceDefinition['id'], path: string): EmployeePackInterfaceDefinition {
  const record = objectRecord(value, path);
  exactKeys(record, ['id', 'label', 'enabled', 'defaultSectionId', 'ownedSectionIds', 'navigationGroups'], path);
  if (record['id'] !== expectedId) throw new Error(`${path}.id 必须是 ${expectedId}`);
  if (typeof record['enabled'] !== 'boolean') throw new Error(`${path}.enabled 必须是布尔值`);
  const defaultSectionId = requiredString(record['defaultSectionId'], `${path}.defaultSectionId`, SECTION_ID);
  const ownedSectionIds = uniqueStringArray(record['ownedSectionIds'], `${path}.ownedSectionIds`, SECTION_ID);
  if (!ownedSectionIds.includes(defaultSectionId)) throw new Error(`${path}.defaultSectionId 必须包含在 ownedSectionIds 中`);
  if (!Array.isArray(record['navigationGroups'])) throw new Error(`${path}.navigationGroups 必须是数组`);

  const navigationIds = new Set<string>();
  const groupIds = new Set<string>();
  const navigationGroups = record['navigationGroups'].map((groupValue, groupIndex) => {
    const groupPath = `${path}.navigationGroups[${groupIndex}]`;
    const group = objectRecord(groupValue, groupPath);
    exactKeys(group, ['id', 'label', 'items'], groupPath);
    const id = requiredString(group['id'], `${groupPath}.id`, SECTION_ID);
    if (groupIds.has(id)) throw new Error(`${path} 包含重复导航分组 ID: ${id}`);
    groupIds.add(id);
    if (!Array.isArray(group['items'])) throw new Error(`${groupPath}.items 必须是数组`);
    const items = group['items'].map((itemValue, itemIndex) => {
      const itemPath = `${groupPath}.items[${itemIndex}]`;
      const item = objectRecord(itemValue, itemPath);
      exactKeys(item, ['id', 'label', 'icon'], itemPath);
      const itemId = requiredString(item['id'], `${itemPath}.id`, SECTION_ID);
      if (!ownedSectionIds.includes(itemId)) throw new Error(`${itemPath}.id 未在 ownedSectionIds 中声明`);
      if (navigationIds.has(itemId)) throw new Error(`${path} 包含重复导航 ID: ${itemId}`);
      navigationIds.add(itemId);
      return {
        id: itemId,
        label: requiredString(item['label'], `${itemPath}.label`),
        icon: requiredString(item['icon'], `${itemPath}.icon`, ICON_ID),
      };
    });
    return { id, label: navigationGroupLabel(group['label'], `${groupPath}.label`), items };
  });

  return {
    id: expectedId,
    label: requiredString(record['label'], `${path}.label`),
    enabled: record['enabled'],
    defaultSectionId,
    ownedSectionIds,
    navigationGroups,
  };
}

function validateLifecycle(value: unknown, declaredWorkflowIds: readonly string[]): EmployeePackLifecycleContract {
  const path = 'EmployeePackManifest.lifecycle';
  const record = objectRecord(value, path);
  exactKeys(record, ['entityType', 'startStageId', 'terminalStageId', 'stages'], path);
  if (!Array.isArray(record['stages']) || record['stages'].length === 0) throw new Error(`${path}.stages 必须是非空数组`);
  const declared = new Set(declaredWorkflowIds);
  const stageIds = new Set<string>();
  const stages = record['stages'].map((stageValue, index) => {
    const stagePath = `${path}.stages[${index}]`;
    const stage = objectRecord(stageValue, stagePath);
    exactKeys(stage, ['id', 'label', 'description', 'workflowIds'], stagePath);
    const id = requiredString(stage['id'], `${stagePath}.id`, SECTION_ID);
    if (stageIds.has(id)) throw new Error(`${path}.stages 包含重复阶段 ID: ${id}`);
    stageIds.add(id);
    const workflowIds = uniqueStringArray(stage['workflowIds'], `${stagePath}.workflowIds`);
    for (const workflowId of workflowIds) {
      if (!declared.has(workflowId)) throw new Error(`${stagePath}.workflowIds 引用了未声明工作流: ${workflowId}`);
    }
    return {
      id,
      label: requiredString(stage['label'], `${stagePath}.label`),
      description: requiredString(stage['description'], `${stagePath}.description`),
      workflowIds,
    };
  });
  const startStageId = requiredString(record['startStageId'], `${path}.startStageId`, SECTION_ID);
  const terminalStageId = requiredString(record['terminalStageId'], `${path}.terminalStageId`, SECTION_ID);
  if (!stageIds.has(startStageId)) throw new Error(`${path}.startStageId 未在 stages 中声明`);
  if (!stageIds.has(terminalStageId)) throw new Error(`${path}.terminalStageId 未在 stages 中声明`);
  if (stages[0]?.id !== startStageId) throw new Error(`${path}.startStageId 必须是首个阶段`);
  if (stages.at(-1)?.id !== terminalStageId) throw new Error(`${path}.terminalStageId 必须是最后阶段`);
  return {
    entityType: requiredString(record['entityType'], `${path}.entityType`, ASSET_ID),
    startStageId,
    terminalStageId,
    stages,
  };
}

/** 校验来自代码、插件或未来安装包的 Manifest，并拒绝未声明字段。 */
export function validateEmployeePackManifest(value: unknown): EmployeePackManifest {
  const record = objectRecord(value, 'EmployeePackManifest');
  exactKeys(record, ['id', 'version', 'name', 'description', 'defaultEmployeeId', 'branding', 'assets', 'interfaces', 'lifecycle', 'context', 'governance', 'connectors'], 'EmployeePackManifest');

  const branding = objectRecord(record['branding'], 'EmployeePackManifest.branding');
  exactKeys(branding, ['productName', 'employeeSubtitle', 'workspaceLabel', 'themeId'], 'EmployeePackManifest.branding');

  const assets = objectRecord(record['assets'], 'EmployeePackManifest.assets');
  exactKeys(assets, ['employeeSpecIds', 'workerIds', 'workflowIds', 'skillIds', 'toolIds', 'nodeTypeIds'], 'EmployeePackManifest.assets');

  const interfaces = objectRecord(record['interfaces'], 'EmployeePackManifest.interfaces');
  exactKeys(interfaces, ['business', 'developer'], 'EmployeePackManifest.interfaces');

  const context = objectRecord(record['context'], 'EmployeePackManifest.context');
  exactKeys(context, ['entityTypes'], 'EmployeePackManifest.context');

  const governance = objectRecord(record['governance'], 'EmployeePackManifest.governance');
  exactKeys(governance, ['policyIds', 'approvalRuleIds', 'evalCriterionIds'], 'EmployeePackManifest.governance');

  if (!Array.isArray(record['connectors'])) throw new Error('EmployeePackManifest.connectors 必须是数组');
  const connectorIds = new Set<string>();
  const connectors = record['connectors'].map((connectorValue, index) => {
    const path = `EmployeePackManifest.connectors[${index}]`;
    const connector = objectRecord(connectorValue, path);
    exactKeys(connector, ['connectorId', 'required', 'actionIds'], path);
    const connectorId = requiredString(connector['connectorId'], `${path}.connectorId`, ASSET_ID);
    if (connectorIds.has(connectorId)) throw new Error(`EmployeePackManifest.connectors 包含重复连接器: ${connectorId}`);
    connectorIds.add(connectorId);
    if (typeof connector['required'] !== 'boolean') throw new Error(`${path}.required 必须是布尔值`);
    return { connectorId, required: connector['required'], actionIds: uniqueStringArray(connector['actionIds'], `${path}.actionIds`) };
  });

  const employeeSpecIds = uniqueStringArray(assets['employeeSpecIds'], 'EmployeePackManifest.assets.employeeSpecIds');
  const workerIds = uniqueStringArray(assets['workerIds'], 'EmployeePackManifest.assets.workerIds');
  const workflowIds = uniqueStringArray(assets['workflowIds'], 'EmployeePackManifest.assets.workflowIds');
  const skillIds = uniqueStringArray(assets['skillIds'], 'EmployeePackManifest.assets.skillIds');
  const toolIds = uniqueStringArray(assets['toolIds'], 'EmployeePackManifest.assets.toolIds');
  const nodeTypeIds = uniqueStringArray(assets['nodeTypeIds'], 'EmployeePackManifest.assets.nodeTypeIds');

  const manifest: EmployeePackManifest = {
    id: requiredString(record['id'], 'EmployeePackManifest.id', PACK_ID),
    version: requiredString(record['version'], 'EmployeePackManifest.version', VERSION),
    name: requiredString(record['name'], 'EmployeePackManifest.name'),
    description: requiredString(record['description'], 'EmployeePackManifest.description'),
    ...(record['defaultEmployeeId'] === undefined ? {} : { defaultEmployeeId: requiredString(record['defaultEmployeeId'], 'EmployeePackManifest.defaultEmployeeId', ASSET_ID) }),
    branding: {
      productName: requiredString(branding['productName'], 'EmployeePackManifest.branding.productName'),
      employeeSubtitle: requiredString(branding['employeeSubtitle'], 'EmployeePackManifest.branding.employeeSubtitle'),
      workspaceLabel: requiredString(branding['workspaceLabel'], 'EmployeePackManifest.branding.workspaceLabel'),
      themeId: requiredString(branding['themeId'], 'EmployeePackManifest.branding.themeId', ASSET_ID),
    },
    assets: {
      employeeSpecIds,
      workerIds,
      workflowIds,
      skillIds,
      toolIds,
      nodeTypeIds,
    },
    interfaces: {
      business: validateInterface(interfaces['business'], 'business', 'EmployeePackManifest.interfaces.business'),
      developer: validateInterface(interfaces['developer'], 'developer', 'EmployeePackManifest.interfaces.developer'),
    },
    ...(record['lifecycle'] === undefined ? {} : { lifecycle: validateLifecycle(record['lifecycle'], workflowIds) }),
    context: { entityTypes: uniqueStringArray(context['entityTypes'], 'EmployeePackManifest.context.entityTypes') },
    governance: {
      policyIds: uniqueStringArray(governance['policyIds'], 'EmployeePackManifest.governance.policyIds'),
      approvalRuleIds: uniqueStringArray(governance['approvalRuleIds'], 'EmployeePackManifest.governance.approvalRuleIds'),
      evalCriterionIds: uniqueStringArray(governance['evalCriterionIds'], 'EmployeePackManifest.governance.evalCriterionIds'),
    },
    connectors,
  };
  return clone(manifest);
}

export class EmployeePackRegistry {
  private readonly manifests = new Map<string, EmployeePackManifest>();

  constructor(manifests: unknown[] = []) {
    for (const manifest of manifests) this.register(manifest);
  }

  register(input: unknown): void {
    const manifest = validateEmployeePackManifest(input);
    if (this.manifests.has(manifest.id)) throw new Error(`Employee Pack 已注册: ${manifest.id}`);
    this.manifests.set(manifest.id, manifest);
  }

  get(id: string): EmployeePackManifest | undefined {
    const manifest = this.manifests.get(id);
    return manifest ? clone(manifest) : undefined;
  }

  list(): EmployeePackManifest[] {
    return [...this.manifests.values()].map((manifest) => clone(manifest));
  }
}

export const CORE_WORKFORCE_EMPLOYEE_PACK: EmployeePackManifest = validateEmployeePackManifest({
  id: 'capability:workforce-core',
  version: '0.1.0',
  name: 'Readywork Core Workforce',
  description: '通用 AI 员工身份、任务、审批、上下文与开发者控制面。',
  branding: {
    productName: 'READYWORK',
    employeeSubtitle: '通用 AI 员工',
    workspaceLabel: '员工工作区',
    themeId: 'readywork-core',
  },
  assets: {
    employeeSpecIds: [],
    workerIds: [],
    workflowIds: ['employee-task-orchestrator'],
    skillIds: [],
    toolIds: [],
    nodeTypeIds: [],
  },
  interfaces: {
    business: {
      id: 'business', label: '业务视图', enabled: true, defaultSectionId: 'employees',
      ownedSectionIds: ['overview', 'org', 'employees', 'tasks', 'approvals', 'context', 'tools'],
      navigationGroups: [
        { id: 'workforce', label: '员工平台', items: [
          { id: 'overview', label: '总览', icon: 'layout-dashboard' },
          { id: 'employees', label: 'AI 员工', icon: 'bot' },
          { id: 'tasks', label: '任务', icon: 'list-checks' },
          { id: 'approvals', label: '审批', icon: 'shield-check' },
        ] },
        { id: 'platform', label: '平台', items: [
          { id: 'org', label: '组织', icon: 'users-round' },
          { id: 'context', label: '上下文', icon: 'network' },
          { id: 'tools', label: '工具与连接', icon: 'plug' },
        ] },
      ],
    },
    developer: {
      id: 'developer', label: '开发者视图', enabled: true, defaultSectionId: 'employees',
      ownedSectionIds: ['employees'], navigationGroups: [],
    },
  },
  context: { entityTypes: [] },
  governance: { policyIds: [], approvalRuleIds: [], evalCriterionIds: [] },
  connectors: [],
});
