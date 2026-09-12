/**
 * Readywork Graph Runtime contracts.
 *
 * Architecture informed by Graphon (Apache-2.0) and common node-based workflow
 * engines. This is an independent TypeScript implementation for procurement.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type NodeCategory = 'trigger' | 'ai' | 'logic' | 'human' | 'business' | 'connector' | 'action';
export type PortCardinality = 'one' | 'many';
export type ParameterControl = 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'json' | 'credential' | 'expression';
export type WorkflowNodeKind = 'trigger' | 'router' | 'ai' | 'logic' | 'tool' | 'approval' | 'action';
export type WorkflowRunMode = 'simulate' | 'shadow' | 'supervised' | 'autonomous';
export type ApprovalLevel = 'auto' | 'buyer' | 'manager' | 'finance';

export interface NodePortDescriptor {
  id: string;
  label: string;
  dataType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'file' | 'event' | 'any';
  required?: boolean;
  cardinality?: PortCardinality;
  description?: string;
}

export interface NodeParameterDescriptor {
  id: string;
  label: string;
  control: ParameterControl;
  required?: boolean;
  defaultValue?: JsonValue;
  description?: string;
  options?: { label: string; value: string }[];
  expression?: boolean;
  secret?: boolean;
}

export interface CredentialRequirement {
  type: string;
  required: boolean;
  scopes?: string[];
  description?: string;
}

export interface NodeTypeDescriptor {
  type: string;
  version: number;
  name: string;
  description: string;
  icon: string;
  category: NodeCategory;
  inputs: NodePortDescriptor[];
  outputs: NodePortDescriptor[];
  parameters: NodeParameterDescriptor[];
  credentials: CredentialRequirement[];
  runtime: 'builtin' | 'connector' | 'plugin';
  executor: string;
  sideEffects?: string[];
  timeoutMs?: number;
  retry?: { maximumAttempts: number; initialIntervalMs: number; maximumIntervalMs: number };
}

export interface GraphNode {
  id: string;
  type: string;
  typeVersion: number;
  name: string;
  config?: Record<string, JsonValue>;
  position?: { x: number; y: number };
}

/**
 * Editor、发布版本和 Temporal 共用的唯一节点定义。
 * NodeTypeDescriptor 描述“节点类型”，WorkflowNodeDefinition 描述“图中的节点实例”。
 */
export interface WorkflowNodeDefinition extends GraphNode {
  kind: WorkflowNodeKind;
  label: string;
  detail: string;
  icon?: string;
  parameters?: Record<string, JsonValue>;
  credentialRef?: string;
  inputs?: string[];
  outputs?: string[];
  rules?: Array<{ cond: string; action: string; level: ApprovalLevel }>;
  retries?: number;
  failAction?: string;
  permission?: string;
  timeoutMs?: number;
  sideEffects?: string[];
}

/** 发布图使用稳定的 from/to 边契约；端口和条件为可选扩展。 */
export interface WorkflowEdgeDefinition {
  id?: string;
  from: string;
  to: string;
  label?: string;
  sourcePort?: string;
  targetPort?: string;
  condition?: string;
}

/** 控制面发布后交给任意可靠执行器的不可变版本。 */
export interface WorkflowVersionDefinition {
  tenantId: string;
  employeeId: string;
  workflowId: string;
  workflowName: string;
  versionId: string;
  version: string;
  nodes: WorkflowNodeDefinition[];
  edges: WorkflowEdgeDefinition[];
}

/** Temporal、测试运行器和未来其他执行器共享同一套纯图遍历规则。 */
export function workflowRootNodeIds(definition: Pick<WorkflowVersionDefinition, 'nodes' | 'edges'>): string[] {
  const incoming = new Set(definition.edges.map((edge) => edge.to));
  return definition.nodes.filter((node) => !incoming.has(node.id)).map((node) => node.id);
}

export function workflowOutgoingEdges(definition: Pick<WorkflowVersionDefinition, 'edges'>, nodeId: string): WorkflowEdgeDefinition[] {
  return definition.edges.filter((edge) => edge.from === nodeId);
}

export function selectWorkflowEdges(
  edges: WorkflowEdgeDefinition[],
  selection: { selectedTargets?: string[]; selectedEdgeLabels?: string[] },
  nodeKind?: WorkflowNodeKind,
): WorkflowEdgeDefinition[] {
  if (selection.selectedTargets?.length) return edges.filter((edge) => selection.selectedTargets!.includes(edge.to));
  if (selection.selectedEdgeLabels?.length) {
    return edges.filter((edge) => edge.label && selection.selectedEdgeLabels!.some((label) => edge.label!.includes(label) || label.includes(edge.label!)));
  }
  if (edges.length > 1 && nodeKind !== 'logic') return edges.slice(0, 1);
  return edges;
}

export interface GraphEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  label?: string;
  condition?: string;
}

export interface GraphDefinition {
  id: string;
  tenantId: string;
  employeeId: string;
  name: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface NodeExecutionContext {
  tenantId: string;
  employeeId: string;
  workflowId: string;
  workflowVersionId: string;
  runId: string;
  nodeRunId: string;
  mode: WorkflowRunMode;
  variables: Readonly<Record<string, unknown>>;
  credentials: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface NodeExecutionResult {
  status: 'completed' | 'waiting_human' | 'waiting_external' | 'blocked' | 'failed';
  outputs: Record<string, unknown>;
  selectedPorts?: string[];
  selectedEdgeLabels?: string[];
  message?: string;
  businessActivity?: { type: string; title: string; summary: string; objectId?: string };
}

export interface NodeExecutor {
  execute(node: GraphNode, input: Record<string, unknown>, context: NodeExecutionContext): Promise<NodeExecutionResult>;
}

export class NodeFactory {
  private descriptors = new Map<string, NodeTypeDescriptor>();
  private executors = new Map<string, NodeExecutor>();

  register(descriptor: NodeTypeDescriptor, executor: NodeExecutor): void {
    const key = nodeTypeKey(descriptor.type, descriptor.version);
    if (this.descriptors.has(key)) throw new Error(`节点类型已注册: ${key}`);
    validateNodeTypeDescriptor(descriptor);
    this.descriptors.set(key, structuredClone(descriptor));
    this.executors.set(key, executor);
  }

  describe(type: string, version: number): NodeTypeDescriptor | undefined {
    const found = this.descriptors.get(nodeTypeKey(type, version));
    return found ? structuredClone(found) : undefined;
  }

  list(): NodeTypeDescriptor[] {
    return [...this.descriptors.values()].map((item) => structuredClone(item));
  }

  create(node: GraphNode): NodeExecutor {
    const key = nodeTypeKey(node.type, node.typeVersion);
    const executor = this.executors.get(key);
    if (!executor) throw new Error(`未注册节点执行器: ${key}`);
    return executor;
  }
}

export class VariablePool {
  private values = new Map<string, unknown>();

  constructor(seed: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(seed)) this.values.set(key, structuredClone(value));
  }

  get<T = unknown>(selector: string | string[]): T | undefined {
    const path = Array.isArray(selector) ? selector : selector.split('.').filter(Boolean);
    if (path.length === 0) return undefined;
    let value: unknown = this.values.get(path[0]!);
    for (const segment of path.slice(1)) {
      if (!value || typeof value !== 'object') return undefined;
      value = (value as Record<string, unknown>)[segment];
    }
    return structuredClone(value) as T | undefined;
  }

  set(selector: string | string[], value: unknown): void {
    const path = Array.isArray(selector) ? selector : selector.split('.').filter(Boolean);
    if (path.length === 0) throw new Error('变量路径不能为空');
    if (path.length === 1) {
      this.values.set(path[0]!, structuredClone(value));
      return;
    }
    const root = structuredClone(this.values.get(path[0]!) ?? {}) as Record<string, unknown>;
    let cursor = root;
    for (const segment of path.slice(1, -1)) {
      const next = cursor[segment];
      cursor[segment] = next && typeof next === 'object' ? structuredClone(next) : {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[path.at(-1)!] = structuredClone(value);
    this.values.set(path[0]!, root);
  }

  merge(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) this.set(key, value);
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries([...this.values.entries()].map(([key, value]) => [key, structuredClone(value)]));
  }

  resolve(template: unknown): unknown {
    if (typeof template !== 'string') return template;
    const exact = template.match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (exact) return this.get(exact[1]!.trim());
    return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, selector: string) => String(this.get(selector.trim()) ?? ''));
  }
}

export interface GraphValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export function validateGraph(graph: GraphDefinition, factory: Pick<NodeFactory, 'describe'>): GraphValidationIssue[] {
  const issues: GraphValidationIssue[] = [];
  const nodes = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (nodes.has(node.id)) issues.push({ code: 'duplicate_node', message: `节点 ID 重复: ${node.id}`, nodeId: node.id });
    nodes.set(node.id, node);
    const descriptor = factory.describe(node.type, node.typeVersion);
    if (!descriptor) {
      issues.push({ code: 'unknown_node_type', message: `未注册节点类型: ${node.type}@${node.typeVersion}`, nodeId: node.id });
      continue;
    }
    for (const parameter of descriptor.parameters.filter((item) => item.required)) {
      if (node.config?.[parameter.id] === undefined && parameter.defaultValue === undefined) {
        issues.push({ code: 'missing_parameter', message: `缺少必填参数: ${parameter.label}`, nodeId: node.id });
      }
    }
  }
  const successors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) {
      issues.push({ code: 'dangling_edge', message: `连线引用不存在节点: ${edge.source} → ${edge.target}`, edgeId: edge.id });
      continue;
    }
    const sourceType = factory.describe(source.type, source.typeVersion);
    const targetType = factory.describe(target.type, target.typeVersion);
    if (sourceType && !sourceType.outputs.some((port) => port.id === edge.sourcePort)) issues.push({ code: 'invalid_source_port', message: `输出端口不存在: ${edge.sourcePort}`, edgeId: edge.id });
    if (targetType && !targetType.inputs.some((port) => port.id === edge.targetPort)) issues.push({ code: 'invalid_target_port', message: `输入端口不存在: ${edge.targetPort}`, edgeId: edge.id });
    successors.set(edge.source, [...(successors.get(edge.source) ?? []), edge.target]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issues.push({ code: 'cycle', message: `检测到未显式循环: ${id}`, nodeId: id });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of successors.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);
  if (graph.nodes.length > 0 && graph.nodes.every((node) => graph.edges.some((edge) => edge.target === node.id))) issues.push({ code: 'missing_root', message: '工作流缺少入口节点' });
  return issues;
}

export interface HumanInputRequest {
  id: string;
  tenantId: string;
  runId: string;
  nodeId: string;
  title: string;
  description: string;
  assignee: { type: 'role' | 'user' | 'group'; id: string };
  fields: Array<{ id: string; label: string; type: 'text' | 'number' | 'boolean' | 'select' | 'date' | 'json'; required?: boolean; options?: string[]; defaultValue?: JsonValue }>;
  delivery: Array<{ type: 'web' | 'email' | 'webhook'; target?: string }>;
  timeoutAt?: string;
  createdAt: string;
}

export interface HumanInputResponse {
  requestId: string;
  decision: 'submitted' | 'approved' | 'rejected' | 'timed_out';
  values: Record<string, JsonValue>;
  by: string;
  note?: string;
  submittedAt: string;
}

export type GraphRuntimeEvent =
  | { type: 'workflow.started'; runId: string; at: string }
  | { type: 'node.queued'; runId: string; nodeId: string; at: string }
  | { type: 'node.started'; runId: string; nodeId: string; nodeRunId: string; at: string }
  | { type: 'node.completed'; runId: string; nodeId: string; nodeRunId: string; outputs: Record<string, unknown>; at: string }
  | { type: 'node.failed'; runId: string; nodeId: string; nodeRunId: string; error: string; at: string }
  | { type: 'human_input.requested'; runId: string; nodeId: string; request: HumanInputRequest; at: string }
  | { type: 'workflow.completed'; runId: string; at: string }
  | { type: 'workflow.failed'; runId: string; error: string; at: string };

function nodeTypeKey(type: string, version: number): string {
  return `${type}@${version}`;
}

function validateNodeTypeDescriptor(descriptor: NodeTypeDescriptor): void {
  if (!descriptor.type || !descriptor.name || !descriptor.executor) throw new Error('节点描述必须包含 type、name 和 executor');
  if (!Number.isInteger(descriptor.version) || descriptor.version < 1) throw new Error('节点版本必须是正整数');
  const inputIds = new Set<string>();
  const outputIds = new Set<string>();
  for (const port of descriptor.inputs) {
    if (inputIds.has(port.id)) throw new Error(`输入端口重复: ${port.id}`);
    inputIds.add(port.id);
  }
  for (const port of descriptor.outputs) {
    if (outputIds.has(port.id)) throw new Error(`输出端口重复: ${port.id}`);
    outputIds.add(port.id);
  }
}
