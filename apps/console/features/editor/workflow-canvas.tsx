"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  reconnectEdge,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import type {
  Connection,
  Edge,
  Node,
  NodeProps,
  OnDelete,
  OnReconnect,
  ReactFlowInstance,
  XYPosition,
} from "@xyflow/react";
import {
  BoxSelect,
  Copy,
  GitBranch,
  LayoutGrid,
  LocateFixed,
  Maximize2,
  Minimize2,
  Redo2,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkflowNodeRuntimeState, WorkflowRuntimeOverlay } from "@/features/editor/workflow-runtime-overlay";

export type CanvasNodeKind = "trigger" | "router" | "ai" | "logic" | "tool" | "approval" | "action";

export interface CanvasNodeDefinition {
  id: string;
  kind: CanvasNodeKind;
  label: string;
  detail: string;
  position?: XYPosition;
  inputs?: string[];
  outputs?: string[];
  retries?: number;
  permission?: string;
  sideEffects?: string[];
}

export interface CanvasEdgeDefinition {
  id?: string;
  from: string;
  to: string;
  label?: string;
  sourcePort?: string;
  targetPort?: string;
  condition?: string;
}

interface WorkflowNodeData extends Record<string, unknown> {
  definition: CanvasNodeDefinition;
  runtime?: WorkflowNodeRuntimeState;
}

type WorkflowFlowNode = Node<WorkflowNodeData, "workflowNode">;
type WorkflowFlowEdge = Edge;

interface GraphSnapshot {
  nodes: CanvasNodeDefinition[];
  edges: CanvasEdgeDefinition[];
}

export interface WorkflowCanvasProps {
  workflowId: string;
  revision: number;
  nodes: CanvasNodeDefinition[];
  edges: CanvasEdgeDefinition[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  saving: boolean;
  loading: boolean;
  runtimeOverlay?: WorkflowRuntimeOverlay | null;
  onSelectNode: (nodeId: string | null) => void;
  onSelectEdge: (edgeId: string | null) => void;
  onAddAsset: (assetId: string, position: XYPosition) => Promise<void>;
  onCommit: (nodes: CanvasNodeDefinition[], edges: CanvasEdgeDefinition[], message: string) => Promise<boolean>;
}

const KIND_STYLE: Record<CanvasNodeKind, { label: string; border: string; chip: string; dot: string; mini: string }> = {
  trigger: { label: "触发器", border: "border-emerald-200", chip: "bg-emerald-50 text-emerald-700", dot: "bg-emerald-500", mini: "#10b981" },
  router: { label: "路由", border: "border-blue-300", chip: "bg-blue-50 text-blue-700", dot: "bg-blue-500", mini: "#3b82f6" },
  ai: { label: "AI 能力", border: "border-violet-200", chip: "bg-violet-50 text-violet-700", dot: "bg-violet-500", mini: "#8b5cf6" },
  logic: { label: "逻辑", border: "border-amber-200", chip: "bg-amber-50 text-amber-700", dot: "bg-amber-500", mini: "#f59e0b" },
  tool: { label: "工具", border: "border-slate-300", chip: "bg-slate-100 text-slate-600", dot: "bg-slate-500", mini: "#64748b" },
  approval: { label: "人工审批", border: "border-rose-200", chip: "bg-rose-50 text-rose-700", dot: "bg-rose-500", mini: "#f43f5e" },
  action: { label: "业务动作", border: "border-sky-200", chip: "bg-sky-50 text-sky-700", dot: "bg-sky-500", mini: "#0ea5e9" },
};

const RUNTIME_STYLE: Record<WorkflowNodeRuntimeState["status"], { label: string; pill: string; ring: string; dot: string; mini: string }> = {
  running: { label: "执行中", pill: "bg-blue-50 text-blue-700", ring: "ring-2 ring-blue-400 ring-offset-2 shadow-blue-100", dot: "bg-blue-500 animate-pulse", mini: "#2563eb" },
  waiting: { label: "等待人工/事件", pill: "bg-amber-50 text-amber-700", ring: "ring-2 ring-amber-400 ring-offset-2 shadow-amber-100", dot: "bg-amber-500 animate-pulse", mini: "#f59e0b" },
  completed: { label: "已完成", pill: "bg-emerald-50 text-emerald-700", ring: "ring-2 ring-emerald-300 ring-offset-2 shadow-emerald-100", dot: "bg-emerald-500", mini: "#10b981" },
  blocked: { label: "副作用已拦截", pill: "bg-amber-50 text-amber-700", ring: "ring-2 ring-amber-300 ring-offset-2 shadow-amber-100", dot: "bg-amber-500", mini: "#f59e0b" },
  failed: { label: "执行失败", pill: "bg-red-50 text-red-700", ring: "ring-2 ring-red-400 ring-offset-2 shadow-red-100", dot: "bg-red-500", mini: "#ef4444" },
};

const REACT_FLOW_ZH_ARIA_LABELS = {
  "node.a11yDescription.default": "按 Enter 或空格选择节点，按 Delete 删除，按 Escape 取消。",
  "node.a11yDescription.keyboardDisabled": "按 Enter 或空格选择节点，再用方向键移动；按 Delete 删除，按 Escape 取消。",
  "node.a11yDescription.ariaLiveMessage": ({ direction, x, y }: { direction: string; x: number; y: number }) => {
    const directionLabel: Record<string, string> = { left: "左", right: "右", up: "上", down: "下" };
    return `已向${directionLabel[direction] ?? "指定"}移动所选节点，新位置：横坐标 ${x}，纵坐标 ${y}`;
  },
  "edge.a11yDescription.default": "按 Enter 或空格选择连线，按 Delete 删除，按 Escape 取消。",
  "controls.ariaLabel": "画布控制面板",
  "controls.zoomIn.ariaLabel": "放大画布",
  "controls.zoomOut.ariaLabel": "缩小画布",
  "controls.fitView.ariaLabel": "适配全部节点",
  "controls.interactive.ariaLabel": "切换画布交互",
  "minimap.ariaLabel": "画布缩略图",
  "handle.ariaLabel": "节点端口",
};

function edgeId(edge: CanvasEdgeDefinition, index: number): string {
  return edge.id ?? `edge:${index}:${edge.from}:${edge.to}`;
}

export function autoLayout(nodes: CanvasNodeDefinition[], edges: CanvasEdgeDefinition[]): CanvasNodeDefinition[] {
  if (nodes.length === 0) return [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
    predecessors.set(edge.to, [...(predecessors.get(edge.to) ?? []), edge.from]);
  }

  const layers = new Map<string, number>();
  const queue = nodes
    .filter((node) => (incoming.get(node.id) ?? 0) === 0)
    .sort((a, b) => (a.position?.y ?? originalIndex.get(a.id) ?? 0) - (b.position?.y ?? originalIndex.get(b.id) ?? 0))
    .map((node) => node.id);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const layer = layers.get(current) ?? 0;
    for (const target of outgoing.get(current) ?? []) {
      layers.set(target, Math.max(layers.get(target) ?? 0, layer + 1));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }

  // The editor prevents new cycles, but legacy graphs can still contain one.
  // Keep every unresolved node visible in a deterministic fallback layer.
  for (const node of nodes) {
    if (layers.has(node.id)) continue;
    const resolvedParents = (predecessors.get(node.id) ?? []).map((id) => layers.get(id)).filter((layer): layer is number => layer !== undefined);
    layers.set(node.id, resolvedParents.length > 0 ? Math.max(...resolvedParents) + 1 : 0);
  }

  const grouped = new Map<number, CanvasNodeDefinition[]>();
  for (const node of nodes) {
    const layer = layers.get(node.id) ?? 0;
    grouped.set(layer, [...(grouped.get(layer) ?? []), node]);
  }

  const layerNumbers = [...grouped.keys()].sort((a, b) => a - b);
  const kindOrder: Record<CanvasNodeKind, number> = { trigger: 0, router: 1, logic: 2, ai: 3, approval: 4, tool: 5, action: 6 };
  for (const layer of layerNumbers) {
    grouped.get(layer)!.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || (a.position?.y ?? originalIndex.get(a.id) ?? 0) - (b.position?.y ?? originalIndex.get(b.id) ?? 0));
  }

  const orderMap = () => {
    const order = new Map<string, number>();
    for (const layer of layerNumbers) grouped.get(layer)!.forEach((node, index) => order.set(node.id, index));
    return order;
  };
  const reorder = (layer: number, neighborIds: (nodeId: string) => string[], order: Map<string, number>) => {
    const group = grouped.get(layer)!;
    const previousOrder = new Map(group.map((node, index) => [node.id, index]));
    group.sort((a, b) => {
      const barycenter = (node: CanvasNodeDefinition) => {
        const neighborOrder = neighborIds(node.id).map((id) => order.get(id)).filter((value): value is number => value !== undefined);
        return neighborOrder.length > 0 ? neighborOrder.reduce((sum, value) => sum + value, 0) / neighborOrder.length : previousOrder.get(node.id)!;
      };
      return barycenter(a) - barycenter(b) || kindOrder[a.kind] - kindOrder[b.kind] || previousOrder.get(a.id)! - previousOrder.get(b.id)!;
    });
  };

  // Repeated forward/backward barycentric sweeps reduce edge crossings while
  // keeping the result stable for the same graph.
  for (let sweep = 0; sweep < 4; sweep += 1) {
    let order = orderMap();
    for (const layer of layerNumbers.slice(1)) {
      reorder(layer, (nodeId) => predecessors.get(nodeId) ?? [], order);
      order = orderMap();
    }
    order = orderMap();
    for (const layer of layerNumbers.slice(0, -1).reverse()) {
      reorder(layer, (nodeId) => outgoing.get(nodeId) ?? [], order);
      order = orderMap();
    }
  }

  const verticalStep = 168;
  const layerHeights = layerNumbers.map((layer) => Math.max(0, (grouped.get(layer)!.length - 1) * verticalStep));
  const maxLayerHeight = Math.max(0, ...layerHeights);
  const positions = new Map<string, XYPosition>();
  for (const layer of layerNumbers) {
    const group = grouped.get(layer)!;
    const layerHeight = Math.max(0, (group.length - 1) * verticalStep);
    const top = 72 + (maxLayerHeight - layerHeight) / 2;
    group.forEach((node, index) => positions.set(node.id, { x: 72 + layer * 360, y: top + index * verticalStep }));
  }
  return nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? { x: 72, y: 72 } }));
}

function normalizeNodes(nodes: CanvasNodeDefinition[], edges: CanvasEdgeDefinition[]): CanvasNodeDefinition[] {
  if (nodes.every((node) => Number.isFinite(node.position?.x) && Number.isFinite(node.position?.y))) return nodes;
  const laidOut = new Map(autoLayout(nodes, edges).map((node) => [node.id, node.position!]));
  return nodes.map((node) => ({ ...node, position: node.position ?? laidOut.get(node.id) ?? { x: 56, y: 76 } }));
}

function toFlowNodes(nodes: CanvasNodeDefinition[], edges: CanvasEdgeDefinition[], selectedNodeId: string | null, runtimeOverlay?: WorkflowRuntimeOverlay | null): WorkflowFlowNode[] {
  return normalizeNodes(nodes, edges).map((definition) => ({
    id: definition.id,
    type: "workflowNode",
    position: definition.position!,
    selected: definition.id === selectedNodeId,
    data: { definition, runtime: runtimeOverlay?.nodes[definition.id] },
  }));
}

function toFlowEdges(edges: CanvasEdgeDefinition[], selectedEdgeId: string | null, runtimeOverlay?: WorkflowRuntimeOverlay | null): WorkflowFlowEdge[] {
  const visited = new Set(runtimeOverlay?.visitedNodeIds ?? []);
  return edges.map((definition, index) => {
    const targetRuntime = runtimeOverlay?.nodes[definition.to];
    const currentTarget = runtimeOverlay?.currentNodeId === definition.to;
    const failed = targetRuntime?.status === "failed";
    const waiting = currentTarget && (targetRuntime?.status === "waiting" || targetRuntime?.status === "blocked");
    const active = currentTarget && targetRuntime?.status === "running";
    const completed = visited.has(definition.from) && visited.has(definition.to) && !failed && !waiting && !active;
    const color = failed ? "#ef4444" : waiting ? "#f59e0b" : active ? "#2563eb" : completed ? "#10b981" : "#94a3b8";
    return {
      id: edgeId(definition, index),
      source: definition.from,
      target: definition.to,
      sourceHandle: definition.sourcePort,
      targetHandle: definition.targetPort,
      label: definition.label,
      selected: edgeId(definition, index) === selectedEdgeId,
      type: "smoothstep",
      reconnectable: true,
      animated: active || waiting,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
      style: { stroke: color, strokeWidth: active || waiting || failed ? 2.4 : completed ? 2 : 1.5 },
      labelStyle: { fill: failed ? "#b91c1c" : waiting ? "#b45309" : active ? "#1d4ed8" : completed ? "#047857" : "#475569", fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "#ffffff", fillOpacity: 0.96 },
      labelBgPadding: [6, 4] as [number, number],
      labelBgBorderRadius: 5,
    };
  });
}

function definitionsFromFlow(flowNodes: WorkflowFlowNode[]): CanvasNodeDefinition[] {
  return flowNodes.map((node) => ({ ...node.data.definition, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } }));
}

function edgesFromFlow(flowEdges: WorkflowFlowEdge[]): CanvasEdgeDefinition[] {
  return flowEdges.map((edge) => ({
    id: edge.id,
    from: edge.source,
    to: edge.target,
    ...(edge.label ? { label: String(edge.label) } : {}),
    ...(edge.sourceHandle ? { sourcePort: edge.sourceHandle } : {}),
    ...(edge.targetHandle ? { targetPort: edge.targetHandle } : {}),
  }));
}

function WorkflowNodeCard({ data, selected }: NodeProps<WorkflowFlowNode>) {
  const node = data.definition;
  const style = KIND_STYLE[node.kind];
  const runtime = data.runtime;
  const runtimeStyle = runtime ? RUNTIME_STYLE[runtime.status] : null;
  const inputs = node.kind === "trigger" ? [] : (node.inputs?.length ? node.inputs : ["in"]);
  const outputs = node.outputs?.length ? node.outputs : ["out"];
  return (
    <div className={cn("relative w-[232px] rounded-xl border bg-white shadow-sm transition", style.border, selected ? "ring-2 ring-blue-500 ring-offset-2 shadow-lg" : runtimeStyle ? `${runtimeStyle.ring} shadow-lg` : "hover:shadow-md")}>
      {inputs.slice(0, 4).map((port, index) => (
        <Handle key={`target:${port}`} id={port} type="target" position={Position.Left} style={{ top: `${32 + index * 18}px`, width: 9, height: 9, border: "2px solid white", background: "#64748b" }} title={`输入：${port}`} />
      ))}
      {outputs.slice(0, 4).map((port, index) => (
        <Handle key={`source:${port}`} id={port} type="source" position={Position.Right} style={{ top: `${32 + index * 18}px`, width: 9, height: 9, border: "2px solid white", background: "#2563eb" }} title={`输出：${port}`} />
      ))}
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", style.dot)} />
          <span className={cn("rounded-md px-1.5 py-0.5 text-[9px] font-semibold", style.chip)}>{style.label}</span>
        </div>
        <div className="flex items-center gap-1 text-[9px] text-slate-400">
          {runtimeStyle ? <span title={runtime?.message ?? runtimeStyle.label} className={cn("flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold", runtimeStyle.pill)}><span className={cn("size-1.5 rounded-full", runtimeStyle.dot)} />{runtimeStyle.label}{runtime?.attempt && runtime.attempt > 1 ? ` · ${runtime.attempt}` : ""}</span> : null}
          {node.retries ? <span>重试 {node.retries}</span> : null}
          {node.sideEffects?.length ? <span className="size-1.5 rounded-full bg-amber-400" title="包含副作用" /> : null}
        </div>
      </div>
      <div className="px-3 py-2.5">
        <div className="truncate text-xs font-semibold text-slate-800">{node.label}</div>
        <div className="mt-1 line-clamp-2 min-h-7 text-[10px] leading-3.5 text-slate-500">{node.detail || "未填写节点说明"}</div>
        <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-1.5 font-mono text-[8px] text-slate-400">
          <span>{inputs.length} 个输入</span><span className="max-w-[130px] truncate">{node.id}</span><span>{outputs.length} 个输出</span>
        </div>
      </div>
    </div>
  );
}

const nodeTypes = { workflowNode: WorkflowNodeCard };

function createsCycle(connection: { source: string; target: string }, edges: WorkflowFlowEdge[]): boolean {
  if (connection.source === connection.target) return true;
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  outgoing.set(connection.source, [...(outgoing.get(connection.source) ?? []), connection.target]);
  const stack = [connection.target];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === connection.source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

export function WorkflowCanvas({
  workflowId,
  revision,
  nodes: definitions,
  edges: edgeDefinitions,
  selectedNodeId,
  selectedEdgeId,
  saving,
  loading,
  runtimeOverlay,
  onSelectNode,
  onSelectEdge,
  onAddAsset,
  onCommit,
}: WorkflowCanvasProps) {
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<WorkflowFlowNode>(toFlowNodes(definitions, edgeDefinitions, selectedNodeId, runtimeOverlay));
  const [flowEdges, setFlowEdges, onEdgesChange] = useEdgesState<WorkflowFlowEdge>(toFlowEdges(edgeDefinitions, selectedEdgeId, runtimeOverlay));
  const [instance, setInstance] = useState<ReactFlowInstance<WorkflowFlowNode, WorkflowFlowEdge> | null>(null);
  const [copiedNodeIds, setCopiedNodeIds] = useState<string[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [layouting, setLayouting] = useState(false);
  const history = useRef<GraphSnapshot[]>([]);
  const future = useRef<GraphSnapshot[]>([]);
  const dragStart = useRef<GraphSnapshot | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);

  const snapshot = useCallback((nextNodes = flowNodes, nextEdges = flowEdges): GraphSnapshot => ({ nodes: definitionsFromFlow(nextNodes), edges: edgesFromFlow(nextEdges) }), [flowEdges, flowNodes]);

  useEffect(() => {
    setFlowNodes(toFlowNodes(definitions, edgeDefinitions, selectedNodeId, runtimeOverlay));
    setFlowEdges(toFlowEdges(edgeDefinitions, selectedEdgeId, runtimeOverlay));
  }, [definitions, edgeDefinitions, revision, runtimeOverlay, selectedEdgeId, selectedNodeId, setFlowEdges, setFlowNodes, workflowId]);

  useEffect(() => {
    history.current = [];
    future.current = [];
    setCopiedNodeIds([]);
    setHistoryRevision((value) => value + 1);
  }, [workflowId]);

  useEffect(() => {
    if (!isExpanded) return;
    const previousOverflow = document.body.style.overflow;
    const exitOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setIsExpanded(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", exitOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", exitOnEscape);
    };
  }, [isExpanded]);

  const commit = useCallback(async (nextNodes: WorkflowFlowNode[], nextEdges: WorkflowFlowEdge[], message: string, before?: GraphSnapshot) => {
    const previous = before ?? snapshot();
    history.current.push(previous);
    if (history.current.length > 50) history.current.shift();
    future.current = [];
    setHistoryRevision((value) => value + 1);
    setFlowNodes(nextNodes);
    setFlowEdges(nextEdges);
    const ok = await onCommit(definitionsFromFlow(nextNodes), edgesFromFlow(nextEdges), message);
    if (!ok) {
      setFlowNodes(toFlowNodes(previous.nodes, previous.edges, selectedNodeId, runtimeOverlay));
      setFlowEdges(toFlowEdges(previous.edges, selectedEdgeId, runtimeOverlay));
    }
  }, [onCommit, runtimeOverlay, selectedEdgeId, selectedNodeId, setFlowEdges, setFlowNodes, snapshot]);

  const undo = useCallback(async () => {
    if (saving) return;
    const previous = history.current.pop();
    if (!previous) return;
    const current = snapshot();
    future.current.push(current);
    setHistoryRevision((value) => value + 1);
    const nextNodes = toFlowNodes(previous.nodes, previous.edges, null, runtimeOverlay);
    const nextEdges = toFlowEdges(previous.edges, null, runtimeOverlay);
    setFlowNodes(nextNodes);
    setFlowEdges(nextEdges);
    const ok = await onCommit(previous.nodes, previous.edges, "已撤销上一次画布修改");
    if (!ok) {
      future.current.pop();
      history.current.push(previous);
      setFlowNodes(toFlowNodes(current.nodes, current.edges, selectedNodeId, runtimeOverlay));
      setFlowEdges(toFlowEdges(current.edges, selectedEdgeId, runtimeOverlay));
    }
  }, [onCommit, runtimeOverlay, saving, selectedEdgeId, selectedNodeId, setFlowEdges, setFlowNodes, snapshot]);

  const redo = useCallback(async () => {
    if (saving) return;
    const next = future.current.pop();
    if (!next) return;
    const current = snapshot();
    history.current.push(current);
    setHistoryRevision((value) => value + 1);
    setFlowNodes(toFlowNodes(next.nodes, next.edges, null, runtimeOverlay));
    setFlowEdges(toFlowEdges(next.edges, null, runtimeOverlay));
    const ok = await onCommit(next.nodes, next.edges, "已重做画布修改");
    if (!ok) {
      history.current.pop();
      future.current.push(next);
      setFlowNodes(toFlowNodes(current.nodes, current.edges, selectedNodeId, runtimeOverlay));
      setFlowEdges(toFlowEdges(current.edges, selectedEdgeId, runtimeOverlay));
    }
  }, [onCommit, runtimeOverlay, saving, selectedEdgeId, selectedNodeId, setFlowEdges, setFlowNodes, snapshot]);

  const onConnect = useCallback((connection: Connection) => {
    if (saving || !connection.source || !connection.target || createsCycle(connection, flowEdges)) return;
    const duplicate = flowEdges.some((edge) => edge.source === connection.source && edge.target === connection.target && edge.sourceHandle === connection.sourceHandle && edge.targetHandle === connection.targetHandle);
    if (duplicate) return;
    const nextEdge: WorkflowFlowEdge = {
      id: `edge:${Date.now().toString(36)}`,
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle,
      targetHandle: connection.targetHandle,
      type: "smoothstep",
      reconnectable: true,
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#94a3b8" },
      style: { stroke: "#94a3b8", strokeWidth: 1.5 },
    };
    void commit(flowNodes, [...flowEdges, nextEdge], "已创建节点连线");
  }, [commit, flowEdges, flowNodes, saving]);

  const onReconnect: OnReconnect<WorkflowFlowEdge> = useCallback((oldEdge, connection) => {
    if (saving || createsCycle(connection, flowEdges.filter((edge) => edge.id !== oldEdge.id))) return;
    const nextEdges = reconnectEdge(oldEdge, connection, flowEdges, { shouldReplaceId: false });
    void commit(flowNodes, nextEdges, "已更新节点连线");
  }, [commit, flowEdges, flowNodes, saving]);

  const onDelete: OnDelete<WorkflowFlowNode, WorkflowFlowEdge> = useCallback(({ nodes: deletedNodes, edges: deletedEdges }) => {
    if (saving) return;
    const deletedNodeIds = new Set(deletedNodes.map((node) => node.id));
    const deletedEdgeIds = new Set(deletedEdges.map((edge) => edge.id));
    const nextNodes = flowNodes.filter((node) => !deletedNodeIds.has(node.id));
    const nextEdges = flowEdges.filter((edge) => !deletedEdgeIds.has(edge.id) && !deletedNodeIds.has(edge.source) && !deletedNodeIds.has(edge.target));
    onSelectNode(null);
    onSelectEdge(null);
    void commit(nextNodes, nextEdges, deletedNodes.length ? `已删除 ${deletedNodes.length} 个节点` : `已删除 ${deletedEdges.length} 条连线`);
  }, [commit, flowEdges, flowNodes, onSelectEdge, onSelectNode, saving]);

  const applyAutoLayout = useCallback(async () => {
    if (saving || layouting) return;
    setLayouting(true);
    const laidOut = autoLayout(definitionsFromFlow(flowNodes), edgesFromFlow(flowEdges));
    const nextNodes = toFlowNodes(laidOut, edgesFromFlow(flowEdges), selectedNodeId, runtimeOverlay);
    try {
      await commit(nextNodes, flowEdges, "已自动整理画布布局");
      window.setTimeout(() => void instance?.fitView({ padding: 0.16, duration: 400 }), 40);
    } finally {
      setLayouting(false);
    }
  }, [commit, flowEdges, flowNodes, instance, layouting, runtimeOverlay, saving, selectedNodeId]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!instance || saving) return;
    const assetId = event.dataTransfer.getData("text/editor-asset");
    if (!assetId) return;
    const position = instance.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: true });
    void onAddAsset(assetId, position);
  }, [instance, onAddAsset, saving]);

  const duplicateCopiedNodes = useCallback(() => {
    if (saving || copiedNodeIds.length === 0) return;
    const selected = flowNodes.filter((node) => copiedNodeIds.includes(node.id));
    if (selected.length === 0) return;
    const idMap = new Map(selected.map((node) => [node.id, `${node.id}:copy:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 5)}`]));
    const clones: WorkflowFlowNode[] = selected.map((node) => {
      const id = idMap.get(node.id)!;
      const definition = { ...node.data.definition, id, label: `${node.data.definition.label} 副本`, position: { x: node.position.x + 42, y: node.position.y + 42 } };
      return { ...node, id, selected: true, position: definition.position, data: { definition } };
    });
    const copiedEdges = flowEdges.filter((edge) => idMap.has(edge.source) && idMap.has(edge.target)).map((edge) => ({ ...edge, id: `edge:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 6)}`, source: idMap.get(edge.source)!, target: idMap.get(edge.target)!, selected: false }));
    const nextNodes: WorkflowFlowNode[] = [...flowNodes.map((node): WorkflowFlowNode => ({ ...node, selected: false })), ...clones];
    const nextEdges: WorkflowFlowEdge[] = [...flowEdges.map((edge): WorkflowFlowEdge => ({ ...edge, selected: false })), ...copiedEdges];
    setCopiedNodeIds(clones.map((node) => node.id));
    void commit(nextNodes, nextEdges, `已粘贴 ${clones.length} 个节点`);
  }, [commit, copiedNodeIds, flowEdges, flowNodes, saving]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === "c") {
      const selected = flowNodes.filter((node) => node.selected).map((node) => node.id);
      if (selected.length) {
        event.preventDefault();
        setCopiedNodeIds(selected);
      }
    }
    if (command && event.key.toLowerCase() === "v") {
      event.preventDefault();
      duplicateCopiedNodes();
    }
    if (command && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) void redo(); else void undo();
    }
  }, [duplicateCopiedNodes, flowNodes, redo, undo]);

  const miniMapColor = useCallback((node: WorkflowFlowNode) => node.data.runtime ? RUNTIME_STYLE[node.data.runtime.status].mini : KIND_STYLE[node.data.definition.kind].mini, []);
  const graphIsEmpty = !loading && flowNodes.length === 0;
  void historyRevision;

  return (
    <>
      {isExpanded ? <button type="button" aria-label="退出放大画布" className="fixed inset-0 z-[89] cursor-default bg-slate-950/35 backdrop-blur-sm" onClick={() => setIsExpanded(false)} /> : null}
      <div
        className={cn(
          "relative overflow-hidden border border-slate-200 bg-slate-50 outline-none transition-[height,border-radius] duration-200",
          isExpanded ? "fixed inset-3 z-[90] h-auto min-h-0 rounded-2xl shadow-2xl" : "h-[calc(100dvh-250px)] min-h-[680px] max-h-[1100px] rounded-xl",
        )}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
        onDrop={handleDrop}
      >
      {loading ? <div className="absolute inset-0 z-30 flex items-center justify-center bg-white/70 text-xs text-slate-500 backdrop-blur-sm">正在加载工作流图…</div> : null}
      {graphIsEmpty ? <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center"><div className="rounded-2xl border border-dashed border-slate-300 bg-white/90 px-8 py-6 text-center shadow-sm"><GitBranch className="mx-auto size-6 text-slate-300" /><div className="mt-2 text-sm font-medium text-slate-600">空白工作流</div><div className="mt-1 text-[11px] text-slate-400">从左侧拖入第一个节点开始编排</div></div></div> : null}
      <ReactFlow<WorkflowFlowNode, WorkflowFlowEdge>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onInit={setInstance}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onReconnect={onReconnect}
        onDelete={onDelete}
        onNodeClick={(_event, node) => { onSelectEdge(null); onSelectNode(node.id); }}
        onEdgeClick={(_event, edge) => { onSelectNode(null); onSelectEdge(edge.id); }}
        onPaneClick={() => { onSelectNode(null); onSelectEdge(null); }}
        onNodeDragStart={() => { dragStart.current = snapshot(); }}
        onNodeDragStop={(_event, node, movedNodes) => {
          if (saving) return;
          const moved = new Map([...movedNodes, node].map((item) => [item.id, item.position]));
          const nextNodes = flowNodes.map((item) => moved.has(item.id) ? { ...item, position: moved.get(item.id)! } : item);
          void commit(nextNodes, flowEdges, "已保存节点位置", dragStart.current ?? undefined);
          dragStart.current = null;
        }}
        isValidConnection={(connection) => !createsCycle(connection, flowEdges)}
        deleteKeyCode={["Backspace", "Delete"]}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={["Meta", "Control"]}
        selectionMode={SelectionMode.Partial}
        snapToGrid
        snapGrid={[16, 16]}
        nodesDraggable={!saving}
        edgesReconnectable={!saving}
        fitView={flowNodes.length <= 12}
        fitViewOptions={{ padding: 0.18, minZoom: 0.45, maxZoom: 1 }}
        defaultViewport={{ x: 36, y: 18, zoom: 0.78 }}
        minZoom={0.25}
        maxZoom={1.8}
        panOnScroll
        zoomOnDoubleClick={false}
        onlyRenderVisibleElements
        ariaLabelConfig={REACT_FLOW_ZH_ARIA_LABELS}
        proOptions={{ hideAttribution: true }}
        defaultEdgeOptions={{ type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, color: "#94a3b8" }, style: { stroke: "#94a3b8", strokeWidth: 1.5 } }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#cbd5e1" />
        <MiniMap nodeColor={miniMapColor} pannable zoomable maskColor="rgba(241,245,249,.72)" className="!border !border-slate-200 !bg-white !shadow-sm" />
        <Controls position="bottom-left" showInteractive={false} fitViewOptions={{ padding: 0.18 }} className="!overflow-hidden !rounded-lg !border-slate-200 !shadow-sm" />
        <Panel position="top-left" className="!m-3 flex items-center gap-1 rounded-xl border border-slate-200 bg-white/95 p-1 shadow-sm backdrop-blur">
          <button type="button" disabled={saving || history.current.length === 0} onClick={() => void undo()} className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30" title="撤销 (⌘Z)"><Undo2 className="size-3.5" /></button>
          <button type="button" disabled={saving || future.current.length === 0} onClick={() => void redo()} className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30" title="重做 (⇧⌘Z)"><Redo2 className="size-3.5" /></button>
          <span className="mx-0.5 h-5 w-px bg-slate-200" />
          <button type="button" aria-label="自动整理布局" disabled={saving || layouting || flowNodes.length === 0} onClick={() => void applyAutoLayout()} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30" title="按流程方向分层，整理节点并减少重叠与连线交叉"><LayoutGrid className="size-3.5" />{layouting ? "布局中…" : "自动整理布局"}</button>
          <button type="button" disabled={flowNodes.length === 0} onClick={() => void instance?.fitView({ padding: 0.16, duration: 350 })} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30" title="让全部节点完整显示"><LocateFixed className="size-3.5" />适配视图</button>
          <button type="button" aria-label={isExpanded ? "退出全屏画布" : "全屏显示画布"} aria-pressed={isExpanded} onClick={() => setIsExpanded((value) => !value)} className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[10px] font-medium text-slate-600 transition hover:bg-slate-100 hover:text-slate-900" title={isExpanded ? "退出全屏画布（Esc）" : "全屏显示画布"}>{isExpanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}{isExpanded ? "退出全屏" : "全屏画布"}</button>
          <span className="mx-0.5 h-5 w-px bg-slate-200" />
          <div className="flex items-center gap-1 px-1.5 text-[9px] text-slate-400"><BoxSelect className="size-3" />Shift 框选</div>
          {copiedNodeIds.length > 0 ? <div className="flex items-center gap-1 px-1.5 text-[9px] text-blue-600"><Copy className="size-3" />已复制 {copiedNodeIds.length}</div> : null}
        </Panel>
        <Panel position="top-right" className="!m-3 flex items-center gap-2 rounded-full border border-slate-200 bg-white/95 px-2.5 py-1 text-[9px] text-slate-500 shadow-sm backdrop-blur">
          {runtimeOverlay ? <><span className={cn("size-1.5 rounded-full", ["running", "queued", "waiting_approval", "waiting_external"].includes(runtimeOverlay.runStatus) ? "bg-blue-500 animate-pulse" : runtimeOverlay.runStatus === "failed" ? "bg-red-500" : "bg-emerald-500")} /><span className="font-mono text-slate-600">{runtimeOverlay.runId}</span><span className="h-3 w-px bg-slate-200" /></> : null}
          {saving ? "正在同步图数据…" : `${flowNodes.length} 节点 · ${flowEdges.length} 连线`}
        </Panel>
      </ReactFlow>
      </div>
    </>
  );
}
