"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, SVGProps } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  BriefcaseBusiness,
  Blocks,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  ClipboardList,
  FileCheck2,
  FileText,
  Clock3,
  Command,
  Eye,
  FlaskConical,
  Gauge,
  Globe2,
  History,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Mail,
  MessageSquareText,
  MoreHorizontal,
  Network,
  PackageCheck,
  Play,
  Plug,
  Plus,
  Rocket,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  ShoppingCart,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Unplug,
  WandSparkles,
  Workflow,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { apiRequest, employeeScopedPath, ReadyworkApiError } from "@/features/shared/api-client";
import { WorkflowCanvas } from "@/features/editor/workflow-canvas";
import type { CanvasEdgeDefinition, CanvasNodeDefinition } from "@/features/editor/workflow-canvas";
import { buildWorkflowRuntimeOverlay } from "@/features/editor/workflow-runtime-overlay";
import { ProcurementRequisitions } from "@/features/procurement/requisitions";
import { ProcurementRfqs } from "@/features/procurement/rfqs";
import { ProcurementWorkbench } from "@/features/procurement/workbench";
import { ProcurementOperations } from "@/features/procurement/operations";
import { ProcurementDomainSection } from "@/features/procurement/domain-sections";
import { ProcurementPoEmployee } from "@/features/procurement/po-employee";
import { ProcurementSuppliersWorkbench } from "@/features/procurement/suppliers-workbench";
import { ProcurementApWorkbench } from "@/features/procurement/ap-workbench";
import { ProcurementHomeDashboard } from "@/features/procurement/home-dashboard";
import { ProcurementMessageDrafts } from "@/features/procurement/message-drafts";
import { ProcurementConfigurationWorkbench } from "@/features/procurement/configuration-workbench";
import { ProcurementTenantPreferencesProvider, useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { ProcurementRealtimeProvider } from "@/features/procurement/realtime-events";
import { ProcurementNotifications } from "@/features/procurement/notifications";
import { ProcurementRouteWorkbench } from "@/features/procurement/route-workbench";
import { ProcurementRiskDashboard } from "@/features/procurement/risk-dashboard";
import { ProcurementSlaWorkbench } from "@/features/procurement/sla-workbench";
import { ProcurementAdvancedSlaWorkbench } from "@/features/procurement/advanced-sla-workbench";
import type {
  ChannelConnectionSummary,
  ConfigurationAutoSendSummary,
} from "@/features/procurement/channel-connections-view-model";
import { createLatestConfigurationConnectionsLoader } from "@/features/procurement/channel-connections-view-model";
import {
  activeEmployeePack,
  buildEmployeePackSidebarGroups,
  parseEmployeePackCatalog,
  preferredEmployeeId,
  resolveEmployeePackSection,
  type EmployeePackCatalogView,
  type EmployeePackViewMode,
} from "@/features/platform/employee-packs";
import { ProcurementPoIntake } from "@/features/procurement/po-intake";
import { ProcurementGlobalHeader, type ProcurementHeaderTarget } from "@/features/procurement/global-header";
import { ProcurementSecurityEventsPanel } from "@/features/procurement/security-events-panel";
import { LanguageSwitcher } from "@/features/localization/ui-language";
import { poNavigationIntentFromValue, resetNavigationScroll, resolveNavigationSection, resolveNavigationViewMode, sectionFromNavigationValue, type PurchaseOrderNavigationIntent, type ReadyworkSection as Section } from "@/features/procurement/navigation-state";
import { poDetailTabFromNavigationValue, type PoDetailTabId } from "@/features/procurement/po-detail-navigation";
import { procurementHeaderPresentation, READYWORK_PROCUREMENT_VISUAL_TOKENS } from "@/features/procurement/visual-tokens";
import { usePublicDemo } from "@/features/public-demo/public-demo-context";

function purchaseOrderIdFromUrl(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 512) : null;
}
function writeNavigationUrl(section: Section, purchaseOrderId: string | null, returnTo: Section | null, mode: "push" | "replace" = "push", purchaseOrderTab: PoDetailTabId | null = null, employeeViewMode: EmployeePackViewMode = "business", purchaseOrderIntent: PurchaseOrderNavigationIntent | null = null) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("section");
  url.searchParams.delete("poId");
  url.searchParams.delete("returnTo");
  url.searchParams.delete("poTab");
  url.searchParams.delete("view");
  url.searchParams.delete("poAction");
  if (section === "orders") {
    url.searchParams.set("section", "orders");
    if (purchaseOrderId) url.searchParams.set("poId", purchaseOrderId);
    if (returnTo && returnTo !== "orders") url.searchParams.set("returnTo", returnTo);
    if (purchaseOrderTab) url.searchParams.set("poTab", purchaseOrderTab);
    if (purchaseOrderIntent) url.searchParams.set("poAction", purchaseOrderIntent);
  } else if (section !== "home") {
    url.searchParams.set("section", section);
    if (section === "employees" && employeeViewMode === "developer") url.searchParams.set("view", "developer");
  }
  const state = {
    ...(window.history.state && typeof window.history.state === "object" ? window.history.state : {}),
    readyworkSection: section,
    readyworkViewMode: section === "employees" ? employeeViewMode : "business",
  };
  window.history[mode === "replace" ? "replaceState" : "pushState"](state, "", url);
}
type ViewMode = EmployeePackViewMode;
type BusinessTab = "overview" | "work" | "capability" | "permission" | "context" | "performance" | "settings";
type DevTab = "editor" | "runs" | "rules" | "tests" | "versions" | "logs";
type DeployMode = "shadow" | "supervised" | "autonomous";
type EditorRunMode = "simulate" | "shadow" | "supervised" | "autonomous";

interface WorkflowView { id: string; name: string; description: string; trigger: string; steps: number; runs: number; success: string; }

interface Employee {
  id: string; name: string; role: string; status: string; statusZh: string;
  capabilityPackIds: string[];
  deptName: string; managerName: string; version: string; deployMode: DeployMode;
  goals: { id: string; title: string; description: string; kpis: { id: string; name: string; unit: string; target?: number }[] }[];
  budget?: { monthlyCap: number; currency: string };
  capabilities: { id: string; name: string; description: string; workflows?: string[]; skills?: string[] }[];
  kpi: { successRate: number; interventionRate: number; onTimeRate: number; cost: number };
  stats: { tasksTotal: number; tasksCompleted: number; tasksFailed: number; humanTakeovers: number; totalCost: number };
  workers: { id: string; name: string; description: string; capabilities: string[]; taskTypes: string[] }[];
  workflows: WorkflowView[];
  skills: { id: string; name: string; description: string }[];
  tools: { id: string; name: string; description: string; actions: string[]; connected: boolean }[];
  permissions: { effect: string; action: string; resource: string; note?: string }[];
  policies: { id: string; name: string; message: string; then: string }[];
  approvalRules: { id: string; name: string; message: string }[];
  contextScope: string[];
  context: { entities: { id: string; type: string; attributes: Record<string, unknown> }[] };
  tasks: TaskView[];
  approvals: ApprovalView[];
}

interface EmployeeListItem {
  id: string;
  name: string;
  role: string;
  status: string;
  statusZh: string;
  capabilityPackIds: string[];
}

interface TaskView {
  id: string; workflowId: string; employeeId: string; status: string; statusZh: string;
  risk: string; next: string; attempts: number; supplier: string; item: string; qty: string; promise: string; businessObjectId: string;
  aiAction: string; aiJudgment: string; recommendation: string[]; supplierReply: string; waitHours: number;
  trajectory: { type: string; at: string; reason?: string }[];
}

interface CollaborationWorkItem {
  id: string;
  employeeId: string;
  workflowId: string;
  businessObjectId: string;
  status: string;
  collaborationStatus: "open" | "accepted" | "dismissed" | "reassigned";
  assignedHumanId?: string;
  assignedRole?: string;
  createdAt: string;
  updatedAt: string;
}

interface CollaborationWorkDetail extends CollaborationWorkItem {
  task: unknown;
  approvals: unknown[];
  assignment: { humanId?: string; role?: string; state: CollaborationWorkItem["collaborationStatus"]; updatedAt: string };
}

interface ApprovalView { id: string; taskId: string; title: string; message: string; payload: Record<string, unknown>; requestedAt: string; }

interface ExceptionView {
  id: string; type: string; severity: string; objectId: string; objectType: string; objectStatus: string;
  supplier?: string; item?: string; owner?: string; aiJudgment: string; recommendedAction: string;
  confidence?: number;
  context: Record<string, unknown>; needsApproval: boolean; approvalId?: string; status: string; createdAt: string;
  threeWay?: { po?: { name: string; qty: number; amount: number; promiseDate: string }; receipt?: { name: string; state: string; date: string }; invoice?: { name: string; amount: number; date: string }; variancePct?: number };
  quotes?: Array<{ supplier: string; price: number | null; currency?: string; leadTime: string; onTime: string; score: number | null; recommended?: boolean }>;
  amount?: number;
}

interface Overview {
  activeTasks: number; autoRate: number; totalCost: number;
  employees: { total: number; byStatus: Record<string, number>; byDepartment: Record<string, number> };
  tasks: { total: number; byStatus: Record<string, number>; pendingApprovals: number };
}

interface EventView { type: string; at: string; taskId?: string; employeeId?: string; reason?: string; tool?: string; action?: string; eventType?: string; objectId?: string; error?: string; }

interface OrgData {
  tenants: { id: string; name: string }[];
  departments: { id: string; name: string; tenantId: string; aiCount: number; humanCount: number }[];
  humans: { id: string; name: string; email: string; role: string; managerId?: string }[];
  employees: { id: string; name: string; specId: string; role: string; status: string; statusZh: string; deptId: string; managerId?: string }[];
}

interface ContextData { entities: { id: string; type: string; attributes: Record<string, unknown> }[]; relationships: { from: string; to: string; type: string }[]; }

interface ToolsData { tools: { id: string; name: string; actions: string[]; connected: boolean; implementationMode: "real" | "reference" }[]; connectors: { id: string; name: string; category: string; description: string; status: string }[]; }

type ConnectorRuntimeKind = "builtin" | "local_process" | "debug_process" | "remote_http" | "serverless";
type ConnectorStatus = "available" | "installing" | "installed" | "disabled" | "failed";
interface ConnectorCredentialFieldView {
  id: string; label: string; type: "text" | "password" | "number" | "boolean" | "select";
  required?: boolean; secret?: boolean; defaultValue?: unknown; placeholder?: string; description?: string;
  options?: { label: string; value: string }[];
}
interface ConnectorCredentialSchemaView { type: string; name: string; fields: ConnectorCredentialFieldView[]; testable?: boolean; }
interface ConnectorActionView { id: string; name: string; description: string; sideEffects: string[]; idempotent: boolean; risk: "read" | "low" | "medium" | "high" | "critical"; }
interface ConnectorView {
  id: string; version: number; name: string; description: string; icon: string; vendor: string; category?: string;
  runtime: ConnectorRuntimeKind; distribution?: "builtin" | "official" | "customer"; tags?: string[];
  credentialSchemas?: ConnectorCredentialSchemaView[]; actions: ConnectorActionView[];
  status: ConnectorStatus; healthy: boolean; runtimeHealthy: boolean; credentialReady: boolean; externalVerified: boolean;
  implementationMode: "real" | "reference"; credentialCount: number; healthMessage?: string; error?: string;
}
interface ConnectorCredentialView {
  id: string; connectorId: string; credentialType: string; name: string; status: "untested" | "connected" | "partial" | "failed";
  lastTestedAt?: string; lastError?: string; createdAt: string; updatedAt: string;
}
interface ConnectorEventView { seq: number; connectorId: string; eventType: string; status: string; message: string; createdAt: string; }
interface ConfigurationConnectionsPayload {
  connections: ChannelConnectionSummary[];
  permissions: { manage: boolean };
  autoSend: ConfigurationAutoSendSummary;
}
interface DocumentReadinessView {
  queued?: number; processing?: number; completed?: number; failed?: number; expiredLeases?: number;
  pendingMalwareScan?: number; quarantined?: number; scanFailed?: number; externalSendGate?: string;
  storage?: { backend?: "sqlite" | "s3"; configured?: boolean; status?: string; integrityVerification?: boolean; encryption?: string };
  malwareScanner?: { engine?: "clamd" | "clamscan"; configured?: boolean; status?: string };
}

const EMPLOYEE_PACK_ICONS: Readonly<Record<string, typeof LayoutDashboard>> = {
  "layout-dashboard": LayoutDashboard,
  bell: Bell,
  mail: Mail,
  "shopping-cart": ShoppingCart,
  "globe-2": Globe2,
  activity: Activity,
  "users-round": UsersRound,
  "clock-3": Clock3,
  "shield-check": ShieldCheck,
  settings: Settings,
  bot: Bot,
  "list-checks": ListChecks,
  network: Network,
  plug: Plug,
};

const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (n: number) => `¥${n.toFixed(2)}`;
function StatCard({ label, value, change, icon: Icon }: { label: string; value: string; change: string; icon: typeof Activity }) {
  return (
    <Card className="min-w-0">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-slate-100 text-slate-700"><Icon className="size-4" /></div>
          <span className="text-xs font-medium text-emerald-600">{change}</span>
        </div>
        <div className="mt-5 text-2xl font-semibold tracking-tight text-slate-950">{value}</div>
        <div className="mt-1 text-xs text-slate-500">{label}</div>
      </CardContent>
    </Card>
  );
}

function toneForStatus(status: string): "green" | "blue" | "violet" | "amber" | "red" | "neutral" {
  switch (status) {
    case "completed": case "idle": return "green";
    case "running": case "working": case "queued": return "blue";
    case "waiting_approval": return "violet";
    case "waiting_external": case "waiting_human": return "amber";
    case "failed": case "rejected": case "cancelled": return "red";
    default: return "neutral";
  }
}

const connectorStatusZh: Record<ConnectorStatus, string> = { available: "可安装", installing: "安装中", installed: "已安装", disabled: "已停用", failed: "安装失败" };
const connectorRuntimeZh: Record<ConnectorRuntimeKind, string> = { builtin: "平台内置", local_process: "隔离子进程", debug_process: "调试运行时", remote_http: "远程运行时", serverless: "无服务器" };
const credentialStatusZh: Record<ConnectorCredentialView["status"], string> = { untested: "待测试", connected: "连接正常", partial: "部分可用", failed: "连接失败" };
const editorRunModeZh: Record<EditorRunMode, string> = { simulate: "模拟", shadow: "影子", supervised: "审批", autonomous: "自动" };
const editorSideEffectStatusZh: Record<EditorNodeRunView["sideEffectStatus"], string> = {
  none: "无副作用",
  blocked: "副作用已拦截",
  approval_gate: "副作用已通过审批门禁",
  executed: "副作用已执行",
};

function editorRunStatusZh(status: EditorRunView["status"]): string {
  return ({ queued: "排队中", running: "执行中", completed: "已完成", waiting_approval: "等待审批", waiting_external: "等待外部事件", ready: "已就绪", rejected: "已驳回", failed: "失败", cancelled: "已取消" })[status];
}

function platformStatusZh(status: string): string {
  const labels: Record<string, string> = {
    online: "在线", offline: "离线", idle: "空闲", active: "活跃", working: "工作中",
    queued: "排队中", running: "执行中", completed: "已完成", waiting_approval: "等待审批",
    waiting_external: "等待外部事件", waiting_human: "等待人工", ready: "已就绪",
    rejected: "已驳回", failed: "失败", cancelled: "已取消",
  };
  return labels[status] ?? `未知状态（${status}）`;
}

function eventTone(type: string): string {
  if (type.includes("approved") || type.includes("completed")) return "bg-emerald-500";
  if (type.includes("waiting_approval") || type.includes("approval.requested")) return "bg-violet-500";
  if (type.includes("waiting")) return "bg-amber-500";
  if (type.includes("failed") || type.includes("rejected")) return "bg-red-500";
  if (type.includes("tool.called")) return "bg-blue-500";
  return "bg-slate-400";
}

function eventLabel(type: string): string {
  const map: Record<string, string> = {
    "task.created": "任务创建", "task.started": "任务开始", "task.waiting": "任务挂起等待",
    "task.resumed": "任务恢复", "task.waiting_approval": "进入人工审批", "approval.requested": "创建审批请求",
    "task.approved": "审批通过", "task.rejected": "审批拒绝", "task.completed": "任务完成", "task.failed": "任务失败",
    "task.retrying": "任务重试", "tool.called": "工具调用", "employee.status_changed": "员工状态变更", "context.event": "业务事件",
  };
  return map[type] ?? type;
}

function approvalSummary(payload: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    days: "延期天数", delayDays: "延期天数", variancePct: "差异比例", amount: "涉及金额",
    supplier: "供应商", supplierName: "供应商", poId: "采购单", poName: "采购单",
    item: "物料", promiseDate: "新承诺交期", reason: "原因",
  };
  const entries = Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && typeof value !== "object").slice(0, 5);
  if (entries.length === 0) return "请核对 AI 判断与关联业务单据后处理。";
  return entries.map(([key, value]) => `${labels[key] ?? key}：${String(value)}${key.toLowerCase().includes("pct") ? "%" : key.toLowerCase().includes("days") || key === "days" ? " 天" : ""}`).join(" · ");
}

/** 把工具动作翻译成有业务含义的叙述（Didero 式执行轨迹） */
function toolActionZh(tool?: string, action?: string): string {
  const map: Record<string, string> = {
    "erp.po.get": "读取企业系统采购单",
    "erp.po.update": "更新企业系统采购单",
    "erp.po.close": "关闭采购单",
    "erp.rfq.create": "创建询价单",
    "erp.rfq.award": "写入授标结果",
    "erp.requisition.create": "创建采购需求单",
    "email.send": "发送邮件给供应商",
    "email.inbox.push": "模拟供应商来信",
    "excel.appendRow": "登记台账",
    "pdf.parse": "解析 PDF 附件",
  };
  return map[`${tool ?? ""}.${action ?? ""}`] ?? `执行 ${tool ?? ""}.${action ?? ""}`;
}

/** 异常类型 → 中文 */
function exceptionTypeZh(type: string): string {
  const map: Record<string, string> = {
    delivery_delay: "交期延期",
    three_way_mismatch: "三单不匹配",
    price_variance: "价格差异",
    quantity_variance: "数量差异",
    invoice_without_po: "无PO发票",
    other: "需人工审批",
  };
  return map[type] ?? type;
}

/** 风险等级 → 中文标签 + 为什么是这个风险 */
function exceptionRiskZh(severity: string): { label: string; reason: string; tone: "red" | "amber" | "green" } {
  switch (severity) {
    case "high": return { label: "高风险", reason: "金额或交期影响较大，已超出 AI 自动处理权限", tone: "red" };
    case "medium": return { label: "中风险", reason: "存在业务偏差，需要业务判断确认", tone: "amber" };
    case "low": return { label: "低风险", reason: "信息待确认，常规业务判断即可", tone: "green" };
    default: return { label: severity, reason: "需人工确认", tone: "amber" };
  }
}

interface BizAction { label: string; kind: "approve" | "reject" | "reassign" | "unsupported"; hint: string }

/** 按异常类型给出业务化动作按钮（不是"批准/驳回"，而是采购语言） */
function exceptionActions(type: string): { main: BizAction; secondary: BizAction[]; more: string[] } {
  switch (type) {
    case "other": // RFQ 定标
      return {
        main: { label: "批准推荐供应商", kind: "approve", hint: "按 AI 综合评分最高的供应商定标" },
        secondary: [
          { label: "选择其他供应商", kind: "unsupported", hint: "尚未接入后端" },
          { label: "重新比价", kind: "unsupported", hint: "尚未接入后端" },
        ],
        more: ["暂缓处理", "转交他人", "查看完整 RFQ"],
      };
    case "delivery_delay":
      return {
        main: { label: "接受新交期", kind: "approve", hint: "按供应商确认的新交期继续执行" },
        secondary: [
          { label: "要求分批交付", kind: "unsupported", hint: "尚未接入后端" },
          { label: "要求加急", kind: "unsupported", hint: "尚未接入后端" },
          { label: "升级", kind: "reassign", hint: "升级给更高权限处理" },
        ],
        more: ["转交他人", "查看完整 PO"],
      };
    case "three_way_mismatch":
    case "price_variance":
      return {
        main: { label: "批准差异", kind: "approve", hint: "按发票金额入账，差异记入应付" },
        secondary: [
          { label: "要求重新开票", kind: "unsupported", hint: "尚未接入后端" },
          { label: "等待剩余收货", kind: "unsupported", hint: "尚未接入后端" },
          { label: "暂停应付", kind: "unsupported", hint: "尚未接入后端" },
        ],
        more: ["转交财务", "查看完整 PO"],
      };
    default:
      return {
        main: { label: "批准 AI 建议", kind: "approve", hint: "按 AI 建议动作继续执行" },
        secondary: [
          { label: "驳回", kind: "reject", hint: "退回 AI 重新处理" },
          { label: "重新分配", kind: "reassign", hint: "转给其他负责人" },
        ],
        more: [],
      };
  }
}

/** 业务影响：从上下文/三单数据里算出来，而不是让用户自己读 JSON */
function exceptionImpact(exc: ExceptionView): { label: string; value: string; tone?: string }[] {
  const c = (exc.context ?? {}) as Record<string, unknown>;
  if (exc.type === "delivery_delay") {
    const days = Number(c["delayDays"] ?? c["days"] ?? 0);
    const eta = (s: unknown) => String(s ?? "—").slice(0, 10);
    const risk = days >= 5 ? "高" : days >= 2 ? "中" : "低";
    return [
      { label: "原定交期", value: eta(c["originalEta"] ?? c["baseline"]) },
      { label: "供应商新交期", value: eta(c["newEta"] ?? c["newDate"]) },
      { label: "延期天数", value: `${days} 天`, tone: risk === "高" ? "text-red-600" : risk === "中" ? "text-amber-600" : "text-emerald-600" },
      { label: "停线风险", value: risk, tone: risk === "高" ? "text-red-600" : risk === "中" ? "text-amber-600" : "text-emerald-600" },
    ];
  }
  if (exc.type === "three_way_mismatch" || exc.type === "price_variance") {
    const po = exc.threeWay?.po; const inv = exc.threeWay?.invoice;
    const vp = Number(exc.threeWay?.variancePct ?? c["variance"] ?? 0);
    const diff = inv && po ? inv.amount - po.amount : Number(c["diff"] ?? 0);
    const neg = diff < 0;
    return [
      { label: "PO 金额", value: po ? `¥${po.amount.toLocaleString()}` : "—" },
      { label: "发票金额", value: inv ? `¥${inv.amount.toLocaleString()}` : "—" },
      { label: "金额差异", value: `${neg ? "" : "+"}¥${Math.abs(diff).toLocaleString()}（${vp}%）`, tone: Math.abs(diff) > 0 ? "text-red-600" : "text-emerald-600" },
      { label: "付款影响", value: Math.abs(diff) > 0 ? (neg ? `少付 ¥${Math.abs(diff).toLocaleString()}` : `多付 ¥${Math.abs(diff).toLocaleString()}`) : "无差异", tone: Math.abs(diff) > 0 ? "text-amber-600" : "text-emerald-600" },
    ];
  }
  // RFQ 定标 / 其他：金额、候选、权限、定标方式
  const amount = exc.amount ?? Number(c["amount"] ?? c["totalAmount"] ?? 0);
  const quotes = exc.quotes ?? [];
  const threshold = Number(c["approvalThreshold"] ?? 100000);
  return [
    { label: "采购金额", value: amount ? `¥${amount.toLocaleString()}` : "—" },
    { label: "候选供应商", value: quotes.length ? `${quotes.length} 家` : String(c["supplierCount"] ?? "—") },
    { label: "超自动额度", value: `¥${threshold.toLocaleString()}` },
    { label: "定标方式", value: "综合评分最高" },
  ];
}

/** 关键上下文（第三层）：按类型动态呈现，把数据真正露出来 */
function exceptionContextBlock(exc: ExceptionView): ReactNode | null {
  const c = (exc.context ?? {}) as Record<string, unknown>;
  if (exc.type === "delivery_delay") {
    const eta = (s: unknown) => String(s ?? "—").slice(0, 10);
    return (
      <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex-1 text-center">
          <div className="text-[11px] text-slate-400">原定交期</div>
          <div className="mt-1 text-sm font-semibold text-slate-800">{eta(c["originalEta"] ?? c["baseline"])}</div>
        </div>
        <ArrowRight className="size-4 shrink-0 text-slate-300" />
        <div className="flex-1 text-center">
          <div className="text-[11px] text-amber-500">供应商新交期</div>
          <div className="mt-1 text-sm font-semibold text-amber-700">{eta(c["newEta"] ?? c["newDate"])}</div>
        </div>
        <div className="flex-1 text-center">
          <div className="text-[11px] text-slate-400">延期</div>
          <div className="mt-1 text-sm font-semibold text-red-600">{Number(c["delayDays"] ?? c["days"] ?? 0)} 天</div>
        </div>
      </div>
    );
  }
  if (exc.threeWay) {
    return (
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">采购单 PO</div>
          <div className="mt-1 text-sm font-semibold text-slate-900">{exc.threeWay.po?.name ?? "—"}</div>
          <div className="mt-1 text-xs text-slate-500">数量 {exc.threeWay.po?.qty ?? "—"}</div>
          <div className="text-xs font-medium text-slate-700">金额 ¥{(exc.threeWay.po?.amount ?? 0).toLocaleString()}</div>
          <div className="text-[11px] text-slate-400">承诺交期 {exc.threeWay.po?.promiseDate ?? "—"}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">收货单</div>
          <div className="mt-1 text-sm font-semibold text-slate-900">{exc.threeWay.receipt?.name ?? "未收货"}</div>
          <div className="mt-1 text-xs text-slate-500">{exc.threeWay.receipt?.state ?? "—"}</div>
          <div className="text-[11px] text-slate-400">{exc.threeWay.receipt?.date ?? "—"}</div>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">供应商发票</div>
          <div className="mt-1 text-sm font-semibold text-slate-900">{exc.threeWay.invoice?.name ?? "未开票"}</div>
          <div className="mt-1 text-xs text-slate-500">{exc.threeWay.invoice?.date ?? "—"}</div>
          <div className="text-xs font-medium text-slate-700">金额 ¥{(exc.threeWay.invoice?.amount ?? 0).toLocaleString()}</div>
        </div>
      </div>
    );
  }
  if (exc.quotes && exc.quotes.length > 0) {
    // 供应商报价表：AI 推荐行高亮
    const quotes = exc.quotes;
    return (
      <table className="w-full border-separate border-spacing-0 text-left text-xs">
        <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400">
          <th className="border-b border-slate-100 px-2 py-1.5 font-medium">供应商</th>
          <th className="border-b border-slate-100 px-2 py-1.5 font-medium">报价</th>
          <th className="border-b border-slate-100 px-2 py-1.5 font-medium">交期</th>
          <th className="border-b border-slate-100 px-2 py-1.5 font-medium">准时率</th>
          <th className="border-b border-slate-100 px-2 py-1.5 font-medium">AI 评分</th>
        </tr></thead>
        <tbody>{quotes.map((q, i) => (
          <tr key={i} className={q.recommended ? "bg-blue-50/60" : ""}>
            <td className="border-b border-slate-100 px-2 py-2 font-medium text-slate-700">{q.supplier}{q.recommended ? <Badge tone="blue" className="ml-1.5">AI推荐</Badge> : null}</td>
            <td className="border-b border-slate-100 px-2 py-2 text-slate-600">{q.price === null ? "—" : `${q.currency ? `${q.currency} ` : ""}${q.price.toLocaleString()}`}</td>
            <td className="border-b border-slate-100 px-2 py-2 text-slate-600">{q.leadTime}</td>
            <td className="border-b border-slate-100 px-2 py-2 text-slate-600">{q.onTime}</td>
            <td className="border-b border-slate-100 px-2 py-2"><span className="font-semibold text-blue-700">{q.score === null ? "—" : `${q.score}分`}</span></td>
          </tr>
        ))}</tbody>
      </table>
    );
  }
  return null;
}
function contextEventZh(eventType?: string): string {
  const map: Record<string, string> = {
    "supplier_confirmed": "收到供应商确认",
    "goods_received": "货物到货签收",
    "quote_received": "收到供应商报价",
    "notify.sent": "发送内部通知",
  };
  return map[eventType ?? ""] ?? `业务事件：${eventType ?? ""}`;
}

/** 领域事件 → 业务叙述（Didero 式执行轨迹） */
function narrateEvent(e: EventView): string {
  switch (e.type) {
    case "tool.called": return toolActionZh(e.tool, e.action);
    case "context.event": return contextEventZh(e.eventType);
    case "task.waiting": return `等待外部：${e.reason ?? ""}`;
    case "task.waiting_approval": return "超出自动处理阈值，创建人工审批";
    case "task.approved": return "人工审批通过";
    case "task.rejected": return "审批拒绝";
    case "task.completed": return "任务完成，已回写企业系统";
    case "task.failed": return `任务失败：${e.error ?? ""}`;
    case "task.retrying": return `自动重试：${e.error ?? ""}`;
    case "task.started": return "开始处理";
    case "task.created": return "创建任务";
    case "task.resumed": return "恢复执行";
    default: return eventLabel(e.type);
  }
}

// ---------------------------------------------------------------- Editor 数据模型
// 一个「采购执行员工」内部 = 可编排的执行节点（不再是多个员工）。
// Worker/Skill/Tool 全部降级为 Editor 左侧组件库里的资产，画布里只是节点。

type EditorNodeKind = "trigger" | "router" | "ai" | "logic" | "tool" | "approval" | "action";

interface EditorNodeDef {
  id: string;
  kind: EditorNodeKind;
  label: string;
  detail: string;
  type?: string;
  typeVersion?: number;
  icon?: string;
  parameters?: Record<string, unknown>;
  credentialRef?: string;
  inputs?: string[];
  outputs?: string[];
  rules?: { cond: string; action: string; level: "auto" | "buyer" | "manager" | "finance" }[];
  retries?: number;
  failAction?: string;
  permission?: string;
  timeoutMs?: number;
  sideEffects?: string[];
  position?: { x: number; y: number };
}

interface EditorEdgeDef { id?: string; from: string; to: string; label?: string; sourcePort?: string; targetPort?: string; condition?: string; }

interface EditorWorkflowDef {
  id: string;
  name: string;
  desc: string;
  nodes: EditorNodeDef[];
  edges: EditorEdgeDef[];
  draftRevision?: number;
  publishedRevision?: number;
  publishedVersion?: string;
  updatedAt?: string;
}

interface EditorPortDescriptor { id: string; label: string; dataType: string; required?: boolean; description?: string; }
interface EditorParameterDescriptor { id: string; label: string; control: "text" | "textarea" | "number" | "boolean" | "select" | "json" | "credential" | "expression"; required?: boolean; defaultValue?: unknown; description?: string; options?: { label: string; value: string }[]; secret?: boolean; }
interface EditorCredentialRequirement { type: string; required: boolean; scopes?: string[]; description?: string; }
interface EditorNodeTypeDescriptor {
  type: string; version: number; name: string; description: string; icon: string; category: string;
  inputs: EditorPortDescriptor[]; outputs: EditorPortDescriptor[]; parameters: EditorParameterDescriptor[];
  credentials: EditorCredentialRequirement[]; runtime: "builtin" | "connector" | "plugin"; executor: string; sideEffects?: string[];
}
interface EditorLibraryItem {
  id: string; label: string; desc: string; kind: EditorNodeKind; type: string; typeVersion: number; icon: string;
  inputs: EditorPortDescriptor[]; outputs: EditorPortDescriptor[]; parameters: EditorParameterDescriptor[];
  credentials: EditorCredentialRequirement[]; runtime: "builtin" | "connector" | "plugin"; executor: string; sideEffects: string[];
}
interface EditorLibraryGroup { group: string; items: EditorLibraryItem[]; }
interface EditorVersionView { id: string; version: string; status: "published"; current: boolean; note: string; createdAt: string; workflowCount: number; ruleSetVersion?: string; }
interface EditorRunView {
  id: string; workflowId: string; workflowName: string; mode: EditorRunMode;
  status: "queued" | "running" | "completed" | "waiting_approval" | "waiting_external" | "ready" | "rejected" | "failed" | "cancelled"; decision: Record<string, unknown>;
  sideEffects: "blocked" | "approval_gate" | "enabled"; message: string; createdAt: string; updatedAt?: string;
  workflowVersion?: string; temporalWorkflowId?: string; temporalRunId?: string; runtime?: "temporal" | "legacy"; nodeCount?: number;
}

interface EditorNodeRunView {
  id: string; nodeId: string; nodeLabel: string; nodeKind: EditorNodeKind; status: "running" | "completed" | "blocked" | "failed";
  attempt: number; sideEffectStatus: "none" | "blocked" | "approval_gate" | "executed"; message?: string; error?: string; startedAt: string; finishedAt?: string;
}

interface EditorRunDetail extends EditorRunView { temporalState?: { currentNodeId?: string; visitedNodeIds: string[]; message: string }; nodeRuns: EditorNodeRunView[]; }
interface EditorRuntimeView {
  agentRuntime: {
    runtime: "deepseek-harness" | "inmemory";
    provider: string;
    role: "ai-kernel";
    default: boolean;
    configured: boolean;
    available: boolean;
    model: string;
    readiness: "ready" | "unconfigured" | "unavailable" | "error" | "not_observed";
    isolation: "subprocess" | "in_process";
    error?: string;
    source?: "legacy-agent" | "temporal-worker-config";
    observed?: boolean;
    configuration?: "valid" | "invalid";
    status: "ready" | "unconfigured" | "unavailable" | "error";
    note?: string;
  };
  graphEngine: { name: string; nodeFactory: boolean; variablePool: boolean; graphValidation: boolean; humanInputProtocol: boolean };
  temporal: { connected: boolean; address: string; namespace: string; taskQueue: string; workerObserved: boolean; pollerCount: number; error?: string; workerError?: string };
  connectors: { installed: number; available: number; healthy: number };
  credentials: { encryptedPersistence: boolean; count: number };
}

interface InvoiceMatchUpgradePreview {
  status: "eligible" | "already_current" | "not_applicable";
  workflowId: string;
  currentRevision: number;
  reason: string;
  changedNodeIds: string[];
  addedNodeIds: string[];
  removedEdgeIds: string[];
  addedEdges: { from: string; to: string; label?: string }[];
}
interface InvoiceMatchUpgradeResult { status: "upgraded" | "already_current" | "not_applicable"; preview: InvoiceMatchUpgradePreview; workflow: EditorWorkflowDef; }

interface EditorBlueprintWorkflowDiff {
  workflowId: string;
  workflowName: string;
  status: "current" | "replace";
  currentRevision: number;
  currentNodeCount: number;
  blueprintNodeCount: number;
  currentEdgeCount: number;
  blueprintEdgeCount: number;
  addedNodeIds: string[];
  removedNodeIds: string[];
  changedNodeIds: string[];
  addedEdgeIds: string[];
  removedEdgeIds: string[];
  changedEdgeIds: string[];
  metadataChanged: boolean;
}

interface EditorBlueprintUpgradePreview {
  status: "current" | "upgrade_available";
  packId: string;
  packVersion: string;
  reason: string;
  expectedRevisions: Record<string, number>;
  workflows: EditorBlueprintWorkflowDiff[];
  replacesExistingDrafts: boolean;
  createsBackup: true;
}

interface EditorBlueprintUpgradeResult {
  status: "imported" | "already_current" | "replayed";
  importId: string | null;
  packId: string;
  packVersion: string;
  createdAt: string | null;
  preview: EditorBlueprintUpgradePreview;
  workflows: EditorWorkflowDef[];
}

const agentReadinessZh: Record<EditorRuntimeView["agentRuntime"]["readiness"], string> = { ready: "就绪", unconfigured: "未配置", unavailable: "不可用", error: "错误", not_observed: "未观测" };
const agentIsolationZh: Record<EditorRuntimeView["agentRuntime"]["isolation"], string> = { subprocess: "隔离子进程", in_process: "进程内" };
const agentRuntimeNameZh: Record<EditorRuntimeView["agentRuntime"]["runtime"], string> = { "deepseek-harness": "DeepSeek 隔离运行时", inmemory: "内存运行时" };

function agentRuntimeDiagnosticZh(message: string | null | undefined): string {
  if (!message) return "";
  const normalized = message
    .replace(/^AgentRuntimeConfigError:\s*/u, "")
    .replaceAll("DeepSeek Harness", "DeepSeek 隔离运行时");
  return normalized.includes("配置缺少")
    ? `AI 运行时配置缺失：${normalized}`
    : `AI 运行时异常：${normalized}`;
}

interface EditorNodeDraft {
  label: string; detail: string; inputs: string; outputs: string; permission: string;
  timeoutSeconds: string; retries: string; failAction: string; sideEffects: string; credentialRef: string;
}

/** 迁移前的静态工作流快照：仅供数据迁移对照，生产 Editor 只使用 /api/editor/workflows。 */
const LEGACY_EDITOR_WORKFLOWS_PREVIEW: EditorWorkflowDef[] = [
  {
    id: "procurement-orchestrator",
    name: "采购路径编排",
    desc: "入口编排：一个事件进来，按业务状态动态选路，只跑需要的分支，不做固定流水线。",
    nodes: [
      { id: "trig:erp", kind: "trigger", label: "ERP新事件", detail: "采购域事件进入员工入口", inputs: ["事件类型", "业务对象"], outputs: ["事件事实快照"], retries: 0, timeoutMs: 0 },
      { id: "router:path", kind: "router", label: "采购路径判断", detail: "按 PO/发票/合同/收货状态动态选路", inputs: ["hasPo", "hasInvoice", "hasReceipt", "hasContractPrice"], outputs: ["路径决策"], retries: 0, failAction: "创建系统异常", permission: "auto" },
      { id: "po:exec", kind: "action", label: "PO执行", detail: "订单确认 → 交期 → 催交 → 到货", inputs: ["poId"], outputs: ["交期更新", "到货状态"], retries: 2, failAction: "转异常工作台" },
      { id: "inv:match", kind: "action", label: "发票处理", detail: "识别 → 关联 → 三单匹配 → 应付", inputs: ["invoiceId"], outputs: ["应付建议"], retries: 2, failAction: "转异常工作台" },
      { id: "rfq:run", kind: "action", label: "RFQ询价", detail: "询价 → 比价 → 定标", inputs: ["需求"], outputs: ["中标供应商"], retries: 2, failAction: "转异常工作台" },
      { id: "recv:wait", kind: "logic", label: "等待收货", detail: "发票已到、货未到 → 收货后自动重新匹配", inputs: ["poId"], outputs: ["收货事件"], timeoutMs: 432000000 },
      { id: "rfq:back", kind: "router", label: "返回询价", detail: "供应商拒单 → 回退重新定标", inputs: ["poName"], outputs: ["重询请求"] },
      { id: "ai:delay", kind: "ai", label: "交期检查", detail: "延期判断 → 按天数分级", inputs: ["原承诺交期", "新承诺交期"], outputs: ["延期天数"], rules: [
        { cond: "延期 ≤ 2 天", action: "自动接受", level: "auto" },
        { cond: "延期 3-5 天", action: "采购员审批", level: "buyer" },
        { cond: "延期 > 5 天", action: "采购经理审批", level: "manager" },
      ] },
      { id: "ai:threeway", kind: "ai", label: "三单匹配", detail: "PO / 收货 / 发票三方核对", inputs: ["poAmount", "invoiceAmount", "receiptQty"], outputs: ["差异率"], rules: [
        { cond: "差异 ≤ 1%", action: "自动通过", level: "auto" },
        { cond: "差异 1-3%", action: "财务审批", level: "finance" },
        { cond: "差异 > 3%", action: "采购+财务审批", level: "manager" },
      ] },
      { id: "ai:quote", kind: "ai", label: "比价推荐", detail: "报价×0.6+交期×0.2+准时率×0.2 综合评分", inputs: ["各家报价"], outputs: ["推荐供应商"] },
      { id: "appr:uni", kind: "approval", label: "统一审批", detail: "超出权限 → 提交异常工作台，批准后从断点恢复", inputs: ["异常对象", "AI建议"], outputs: ["审批决定"], retries: 0, failAction: "挂起等待人工", permission: "manager" },
      { id: "erp:write", kind: "action", label: "ERP回写", detail: "更新交期 / 落标 / 应付台账", inputs: ["审批决定"], outputs: ["ERP已更新"], retries: 3, failAction: "创建系统异常" },
    ],
    edges: [
      { from: "trig:erp", to: "router:path" },
      { from: "router:path", to: "po:exec", label: "已有PO" },
      { from: "router:path", to: "inv:match", label: "发票到" },
      { from: "router:path", to: "rfq:run", label: "无有效价格" },
      { from: "router:path", to: "recv:wait", label: "发票到未收货" },
      { from: "router:path", to: "rfq:back", label: "供应商拒单" },
      { from: "recv:wait", to: "inv:match", label: "收货后自动重匹配" },
      { from: "rfq:back", to: "rfq:run", label: "重新定标" },
      { from: "po:exec", to: "ai:delay" },
      { from: "inv:match", to: "ai:threeway" },
      { from: "rfq:run", to: "ai:quote" },
      { from: "ai:delay", to: "appr:uni", label: "超权限" },
      { from: "ai:threeway", to: "appr:uni", label: "差异超限" },
      { from: "ai:quote", to: "appr:uni", label: "金额超额度" },
      { from: "appr:uni", to: "erp:write", label: "批准后恢复" },
    ],
  },
  {
    id: "rfq-process",
    name: "询价与报价",
    desc: "创建询价单 → 邮件询价 → 等待报价 → 解析比价 → 中标审批 → 落单。",
    nodes: [
      { id: "t:rfq", kind: "trigger", label: "询价单创建", detail: "采购需求进入询价", inputs: ["item", "qty", "suppliers"], outputs: ["询价单号"] },
      { id: "m:ask", kind: "tool", label: "邮件询价", detail: "向候选供应商发询价邀请", inputs: ["供应商列表"], outputs: ["询价邮件"], retries: 2 },
      { id: "w:quote", kind: "logic", label: "等待报价", detail: "等待供应商回复（30 秒 / 3 日）", inputs: ["quote_received 事件"], outputs: ["报价邮件"], timeoutMs: 30000 },
      { id: "ai:collect", kind: "ai", label: "报价收集", detail: "汇总各家供应商报价", inputs: ["报价邮件"], outputs: ["报价汇总"] },
      { id: "ai:parse", kind: "ai", label: "报价解析", detail: "提取单价/交期/规格", inputs: ["报价文本"], outputs: ["结构化报价"] },
      { id: "ai:reco", kind: "ai", label: "比价推荐", detail: "综合评分推荐中标供应商", inputs: ["结构化报价"], outputs: ["推荐供应商"] },
      { id: "appr:rfq", kind: "approval", label: "中标审批", detail: "金额超过自动额度需经理审批", inputs: ["推荐供应商"], outputs: ["审批决定"], rules: [
        { cond: "金额 ≤ ¥100,000", action: "自动定标", level: "auto" },
        { cond: "金额 > ¥100,000", action: "采购经理审批", level: "manager" },
      ], permission: "manager" },
      { id: "a:award", kind: "action", label: "落单", detail: "ERP 写入中标结果", inputs: ["rfqId", "supplierId"], outputs: ["已落标"], retries: 3 },
      { id: "n:done", kind: "action", label: "通知", detail: "通知采购员中标结果", outputs: ["通知已发"] },
    ],
    edges: [
      { from: "t:rfq", to: "m:ask" }, { from: "m:ask", to: "w:quote" }, { from: "w:quote", to: "ai:collect" },
      { from: "ai:collect", to: "ai:parse" }, { from: "ai:parse", to: "ai:reco" }, { from: "ai:reco", to: "appr:rfq" },
      { from: "appr:rfq", to: "a:award" }, { from: "a:award", to: "n:done" },
    ],
  },
  {
    id: "po-operations",
    name: "采购订单执行",
    desc: "订单确认 → 等待供应商确认 → 延期检测 → 分级审批 → 更新交期 → 催交 → 到货关闭。",
    nodes: [
      { id: "t:po", kind: "trigger", label: "订单确认", detail: "采购订单发出", inputs: ["poId"], outputs: ["订单快照"] },
      { id: "w:confirm", kind: "logic", label: "等待供应商确认", detail: "等供应商回执交期", inputs: ["supplier_confirmed 事件"], outputs: ["确认邮件"], timeoutMs: 30000 },
      { id: "ai:reply", kind: "ai", label: "回复解析", detail: "提取供应商最新回复文本", inputs: ["确认邮件"], outputs: ["回复文本"] },
      { id: "ai:eta", kind: "ai", label: "交期提取", detail: "从回复提取新确认交期", inputs: ["回复文本"], outputs: ["新交期"] },
      { id: "logic:delay", kind: "logic", label: "延期判断", detail: "对比原交期与新交期", inputs: ["原承诺交期", "新承诺交期"], outputs: ["延期天数"], rules: [
        { cond: "延期 ≤ 2 天", action: "自动接受", level: "auto" },
        { cond: "延期 3-5 天", action: "采购员审批", level: "buyer" },
        { cond: "延期 > 5 天", action: "采购经理审批", level: "manager" },
      ] },
      { id: "appr:delay", kind: "approval", label: "延期审批", detail: "超权限延期提交异常工作台", inputs: ["延期天数", "AI建议"], outputs: ["审批决定"], permission: "manager" },
      { id: "t:update", kind: "tool", label: "ERP更新交期", detail: "真实写 Odoo date_planned", inputs: ["poId", "新交期"], outputs: ["Odoo 已更新"], retries: 3, sideEffects: ["写 ERP"] },
      { id: "ai:follow", kind: "ai", label: "催交沟通", detail: "生成催交邮件并发送", inputs: ["延期信息"], outputs: ["催交邮件"], sideEffects: ["发邮件"] },
      { id: "w:goods", kind: "logic", label: "等待到货", detail: "等 goods_received 事件", inputs: ["goods_received"], outputs: ["到货事件"], timeoutMs: 30000 },
      { id: "a:close", kind: "action", label: "到货关闭", detail: "关单 + 台账登记", inputs: ["poId"], outputs: ["已关闭"] },
    ],
    edges: [
      { from: "t:po", to: "w:confirm" }, { from: "w:confirm", to: "ai:reply" }, { from: "ai:reply", to: "ai:eta" },
      { from: "ai:eta", to: "logic:delay" },
      { from: "logic:delay", to: "t:update", label: "≤2天 自动接受" },
      { from: "logic:delay", to: "appr:delay", label: ">2天 需审批" },
      { from: "appr:delay", to: "t:update", label: "批准后恢复" },
      { from: "t:update", to: "ai:follow" }, { from: "ai:follow", to: "w:goods" }, { from: "w:goods", to: "a:close" },
    ],
  },
  {
    id: "supplier-followup",
    name: "供应商催交",
    desc: "延期事件 → 催交沟通 → 供应商回复 → 交期更新 → 通知。",
    nodes: [
      { id: "t:delay", kind: "trigger", label: "延期事件", detail: "检测到交期风险", inputs: ["poId", "延期天数"] },
      { id: "ai:push", kind: "ai", label: "催交沟通", detail: "生成催交邮件/消息", inputs: ["延期信息"], outputs: ["催交请求"], sideEffects: ["发邮件"] },
      { id: "w:reply", kind: "logic", label: "供应商回复", detail: "等待供应商答复", inputs: ["回复事件"], timeoutMs: 30000 },
      { id: "ai:neweta", kind: "ai", label: "交期提取", detail: "解析新承诺交期", inputs: ["回复文本"], outputs: ["新交期"] },
      { id: "t:upd2", kind: "tool", label: "交期更新", detail: "回写 ERP", inputs: ["poId", "新交期"], retries: 3, sideEffects: ["写 ERP"] },
      { id: "n:notify", kind: "action", label: "通知", detail: "通知采购员最新交期", outputs: ["已通知"] },
    ],
    edges: [
      { from: "t:delay", to: "ai:push" }, { from: "ai:push", to: "w:reply" }, { from: "w:reply", to: "ai:neweta" },
      { from: "ai:neweta", to: "t:upd2" }, { from: "t:upd2", to: "n:notify" },
    ],
  },
  {
    id: "delivery-receipt",
    name: "交付与收货",
    desc: "到货事件 → 订单核对 → 数量核对 → 入库 → 台账。",
    nodes: [
      { id: "t:arrive", kind: "trigger", label: "到货事件", detail: "仓库签收", inputs: ["poId", "实收数量"] },
      { id: "ai:check", kind: "ai", label: "订单核对", detail: "比对采购单信息", inputs: ["poId"], outputs: ["核对结果"] },
      { id: "logic:qty", kind: "logic", label: "数量核对", detail: "实收 vs 应到", inputs: ["实收数量", "应到数量"], outputs: ["差异"], rules: [
        { cond: "数量一致", action: "直接入库", level: "auto" },
        { cond: "短收", action: "创建数量异常", level: "buyer" },
      ] },
      { id: "a:store", kind: "action", label: "入库", detail: "WMS 入库登记", inputs: ["poId", "数量"], retries: 2, sideEffects: ["写 WMS"] },
      { id: "x:ledger", kind: "tool", label: "台账登记", detail: "PO 台账追加行", inputs: ["poId", "状态"] },
      { id: "n:recv", kind: "action", label: "通知", detail: "通知到货关闭" },
    ],
    edges: [
      { from: "t:arrive", to: "ai:check" }, { from: "ai:check", to: "logic:qty" },
      { from: "logic:qty", to: "a:store", label: "数量一致" }, { from: "a:store", to: "x:ledger" }, { from: "x:ledger", to: "n:recv" },
    ],
  },
  {
    id: "invoice-match",
    name: "发票与三单匹配",
    desc: "发票事件 → 识别 → 关联 PO/收货 → 三单匹配 → 差异分级 → 应付台账。",
    nodes: [
      { id: "t:inv", kind: "trigger", label: "发票事件", detail: "供应商发票到达", inputs: ["invoiceId"] },
      { id: "ai:inv", kind: "ai", label: "发票识别", detail: "提取金额/关联 PO 号", inputs: ["发票扫描"], outputs: ["发票要素"] },
      { id: "logic:link", kind: "logic", label: "关联PO/收货", detail: "找到对应采购单与收货单", inputs: ["发票要素"], outputs: ["关联对象"] },
      { id: "ai:tw", kind: "ai", label: "三单匹配", detail: "PO/收货/发票三方核对", inputs: ["poAmount", "invoiceAmount", "receiptQty"], outputs: ["差异率"], rules: [
        { cond: "差异 ≤ 1%", action: "自动通过", level: "auto" },
        { cond: "差异 1-3%", action: "财务审批", level: "finance" },
        { cond: "差异 > 3%", action: "采购+财务审批", level: "manager" },
      ] },
      { id: "appr:tw", kind: "approval", label: "差异审批", detail: "超限差异提交异常工作台", inputs: ["差异率", "AI建议"], outputs: ["审批决定"], permission: "finance" },
      { id: "x:pay", kind: "tool", label: "应付台账", detail: "登记应付金额", inputs: ["invoiceId", "金额", "差异率"], sideEffects: ["写台账"] },
      { id: "n:inv", kind: "action", label: "通知", detail: "通知核对结果" },
    ],
    edges: [
      { from: "t:inv", to: "ai:inv" }, { from: "ai:inv", to: "logic:link" }, { from: "logic:link", to: "ai:tw" },
      { from: "ai:tw", to: "x:pay", label: "≤1% 自动" },
      { from: "ai:tw", to: "appr:tw", label: "超限审批" },
      { from: "appr:tw", to: "x:pay", label: "批准后登记" },
      { from: "x:pay", to: "n:inv" },
    ],
  },
];

/** 迁移前的组件库快照：仅供对照，生产数据来自 /api/editor/catalog。 */
const LEGACY_EDITOR_LIBRARY_PREVIEW: { group: string; items: { id: string; label: string; desc: string; kind: EditorNodeKind }[] }[] = [
  {
    group: "触发器",
    items: [
      { id: "t:erp", label: "ERP事件", desc: "订单/发票/到货事件进入", kind: "trigger" },
      { id: "t:mail", label: "收到邮件", desc: "供应商报价/交期确认", kind: "trigger" },
      { id: "t:cron", label: "定时任务", desc: "周期检查延期/未确认", kind: "trigger" },
      { id: "t:manual", label: "人工触发", desc: "业务人员手动发起", kind: "trigger" },
    ],
  },
  {
    group: "AI能力",
    items: [
      { id: "ai:quote-collect", label: "报价收集", desc: "汇总各家报价", kind: "ai" },
      { id: "ai:quote-reco", label: "比价推荐", desc: "综合评分推荐中标", kind: "ai" },
      { id: "ai:po-check", label: "订单核对", desc: "核对订单信息", kind: "ai" },
      { id: "ai:reply-parse", label: "回复解析", desc: "提取供应商回复", kind: "ai" },
      { id: "ai:eta-extract", label: "交期提取", desc: "提取新确认交期", kind: "ai" },
      { id: "ai:followup", label: "催交沟通", desc: "生成并发送催交", kind: "ai" },
      { id: "ai:inv-parse", label: "发票识别", desc: "提取发票要素", kind: "ai" },
      { id: "ai:threeway", label: "三单匹配", desc: "PO/收货/发票核对", kind: "ai" },
      { id: "ai:intent", label: "事件识别", desc: "采购意图识别", kind: "ai" },
    ],
  },
  {
    group: "业务逻辑",
    items: [
      { id: "l:cond", label: "条件", desc: "if/else 分支", kind: "logic" },
      { id: "l:router", label: "采购路径判断", desc: "按业务状态动态选路", kind: "router" },
      { id: "l:wait", label: "等待", desc: "等待外部事件/定时", kind: "logic" },
      { id: "l:approval", label: "审批", desc: "提交人工审批", kind: "approval" },
      { id: "l:parallel", label: "并行", desc: "多分支并发", kind: "logic" },
    ],
  },
  {
    group: "工具",
    items: [
      { id: "tool:mail", label: "邮箱", desc: "发邮件/收邮件", kind: "tool" },
      { id: "tool:erp", label: "ERP", desc: "读/写采购订单", kind: "tool" },
      { id: "tool:wms", label: "WMS", desc: "入库/库存", kind: "tool" },
      { id: "tool:file", label: "文件", desc: "Excel 台账/附件", kind: "tool" },
    ],
  },
];

const NODE_KIND_STYLE: Record<EditorNodeKind, { box: string; chip: string; label: string }> = {
  trigger: { box: "border-emerald-200 bg-emerald-50", chip: "bg-emerald-100 text-emerald-700", label: "触发器" },
  router: { box: "border-blue-300 bg-blue-50", chip: "bg-blue-100 text-blue-700", label: "路由" },
  ai: { box: "border-violet-200 bg-violet-50", chip: "bg-violet-100 text-violet-700", label: "AI能力" },
  logic: { box: "border-amber-200 bg-amber-50", chip: "bg-amber-100 text-amber-700", label: "逻辑" },
  tool: { box: "border-slate-200 bg-slate-50", chip: "bg-slate-100 text-slate-600", label: "工具" },
  approval: { box: "border-red-200 bg-red-50", chip: "bg-red-100 text-red-700", label: "审批" },
  action: { box: "border-sky-200 bg-sky-50", chip: "bg-sky-100 text-sky-700", label: "动作" },
};

/** Tests 页：回归测试场景（输入喂给真实采购路径编排器） */
const TEST_CASES: { id: string; name: string; desc: string; input: Record<string, unknown> }[] = [
  { id: "t1", name: "正常采购（无合同价）", desc: "采购需求 → 无有效合同价 → 询价", input: { kind: "event", hasPo: false, hasInvoice: false, hasContractPrice: false } },
  { id: "t2", name: "框架合同价有效", desc: "合同价有效 → 跳过询价直接 PO", input: { kind: "event", hasPo: false, hasContractPrice: true, contractPriceValid: true } },
  { id: "t3", name: "已有 PO", desc: "直接 PO 执行，跳过询价", input: { kind: "po", hasPo: true, poName: "P00011" } },
  { id: "t4", name: "发票 + PO + 收货齐全", desc: "三单匹配", input: { kind: "invoice", hasPo: true, hasReceipt: true, hasInvoice: true } },
  { id: "t5", name: "发票到、货未到", desc: "等待收货后自动重新匹配", input: { kind: "invoice", hasPo: true, hasReceipt: false, hasInvoice: true } },
  { id: "t6", name: "无 PO 发票", desc: "异常 → 财务/采购人工审核", input: { kind: "invoice", hasPo: false, hasInvoice: true } },
  { id: "t7", name: "供应商拒单", desc: "返回询价重新定标", input: { kind: "po", intent: "supplier_reject", hasPo: true, hasQualifiedSupplier: true } },
  { id: "t8", name: "无合格供应商", desc: "进入寻源 / 供应商准入", input: { kind: "event", hasPo: false, hasQualifiedSupplier: false } },
];

const ENTRY_ZH: Record<string, string> = {
  rfq: "询价 RFQ", "po-execution": "PO 执行", "invoice-match": "三单匹配", sourcing: "寻源", exception: "异常", "wait-receipt": "等待收货", error: "错误",
};

/** 迁移前的版本快照：生产 Versions 只使用 /api/editor/versions。 */
const LEGACY_VERSIONS_PREVIEW = [
  { v: "v0.1.0-rc.5", at: "2026-08-19", note: "开发者视图 → 编排器画布（组件库/画布/节点设置）", current: true },
  { v: "v0.1.0-rc.4", at: "2026-08-18", note: "异常工作台升级：5 层卡片 + 业务化动作 + 详情抽屉", current: false },
  { v: "v0.1.0-rc.3", at: "2026-08-17", note: "采购路径编排器（动态路由，非固定流水线）", current: false },
  { v: "v0.1.0-rc.2", at: "2026-08-16", note: "统一异常中心 + 通知铃铛 + 聊天确认门", current: false },
  { v: "v0.1.0-rc.1", at: "2026-08-15", note: "首版：AI 采购执行员工 + Odoo 连接", current: false },
];

export default function Page() {
  return <ProcurementRealtimeProvider><ProcurementTenantPreferencesProvider><ReadyworkPageContent /></ProcurementTenantPreferencesProvider></ProcurementRealtimeProvider>;
}

function ReadyworkPageContent() {
  const { formatDateTime, formatTime } = useProcurementLocale();
  const { demoMode: publicDemoMode } = usePublicDemo();
  const dashboardRequestRef = useRef<AbortController | null>(null);
  const dashboardSequenceRef = useRef(0);
  const editorRunSubmittingRef = useRef(false);
  const editorRunRequestRef = useRef<{ signature: string; idempotencyKey: string } | null>(null);
  const [section, setSection] = useState<Section>("home");
  const [initialPurchaseOrderId, setInitialPurchaseOrderId] = useState<string | null>(null);
  const [initialPurchaseOrderTab, setInitialPurchaseOrderTab] = useState<PoDetailTabId>("overview");
  const [initialPurchaseOrderIntent, setInitialPurchaseOrderIntent] = useState<PurchaseOrderNavigationIntent | null>(null);
  const [purchaseOrderReturnTo, setPurchaseOrderReturnTo] = useState<Section | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("business");
  const [tab, setTab] = useState<BusinessTab>("overview");
  const [devTab, setDevTab] = useState<DevTab>("editor");
  const [mode, setMode] = useState<DeployMode>("supervised");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [taskQuery, setTaskQuery] = useState("");
  const [workFilter, setWorkFilter] = useState<"all" | "active" | "waiting" | "done" | "failed">("all");
  const [expandedCap, setExpandedCap] = useState<string | null>(null);
  const [showCapPicker, setShowCapPicker] = useState(false);
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    const applyBrowserNavigation = () => {
      const url = new URL(window.location.href);
      const historySectionValue = (window.history.state as { readyworkSection?: unknown } | null)?.readyworkSection;
      const requestedSection = resolveNavigationSection(url.searchParams.get("section"), historySectionValue);
      const requestedViewMode = resolveNavigationViewMode(requestedSection, url.searchParams.get("view"));
      setViewMode(requestedViewMode);
      if (requestedSection === "orders") {
        const returnTarget = sectionFromNavigationValue(url.searchParams.get("returnTo"));
        setSection("orders");
        setInitialPurchaseOrderId(purchaseOrderIdFromUrl(url.searchParams.get("poId")));
        setInitialPurchaseOrderTab(poDetailTabFromNavigationValue(url.searchParams.get("poTab")) ?? "overview");
        setInitialPurchaseOrderIntent(poNavigationIntentFromValue(url.searchParams.get("poAction")));
        setPurchaseOrderReturnTo(returnTarget && returnTarget !== "orders" ? returnTarget : "home");
        return;
      }
      setSection(requestedSection);
      setInitialPurchaseOrderId(null);
      setInitialPurchaseOrderTab("overview");
      setInitialPurchaseOrderIntent(null);
      setPurchaseOrderReturnTo(null);
    };
    applyBrowserNavigation();
    window.addEventListener("popstate", applyBrowserNavigation);
    return () => window.removeEventListener("popstate", applyBrowserNavigation);
  }, []);

  const [employees, setEmployees] = useState<EmployeeListItem[]>([]);
  const [employeePackCatalog, setEmployeePackCatalog] = useState<EmployeePackCatalogView | null>(null);
  const [employeePackError, setEmployeePackError] = useState<string | null>(null);
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [org, setOrg] = useState<OrgData | null>(null);
  const [context, setContext] = useState<ContextData | null>(null);
  const [toolsData, setToolsData] = useState<ToolsData | null>(null);
  const [connectorsData, setConnectorsData] = useState<ConnectorView[]>([]);
  const [connectorCredentials, setConnectorCredentials] = useState<ConnectorCredentialView[]>([]);
  const [connectorEvents, setConnectorEvents] = useState<ConnectorEventView[]>([]);
  const [connectorQuery, setConnectorQuery] = useState("");
  const [connectorCategory, setConnectorCategory] = useState("全部");
  const [selectedConnectorId, setSelectedConnectorId] = useState("email");
  const [connectorBusy, setConnectorBusy] = useState<string | null>(null);
  const [connectorError, setConnectorError] = useState<string | null>(null);
  const [configurationConnections, setConfigurationConnections] = useState<ChannelConnectionSummary[]>([]);
  const [configurationAutoSend, setConfigurationAutoSend] = useState<ConfigurationAutoSendSummary | null>(null);
  const [configurationConnectionsManageable, setConfigurationConnectionsManageable] = useState(false);
  const [configurationConnectionsLoading, setConfigurationConnectionsLoading] = useState(true);
  const [configurationConnectionsError, setConfigurationConnectionsError] = useState<string | null>(null);
  const [configurationConnectionsLoaded, setConfigurationConnectionsLoaded] = useState(false);
  const configurationConnectionsLoader = useRef<(() => Promise<void>) | null>(null);
  const [documentReadiness, setDocumentReadiness] = useState<DocumentReadinessView | null>(null);
  const [documentReadinessError, setDocumentReadinessError] = useState<string | null>(null);
  const [credentialEditorOpen, setCredentialEditorOpen] = useState(false);
  const [credentialPendingDisconnect, setCredentialPendingDisconnect] = useState<ConnectorCredentialView | null>(null);
  const [credentialDisconnectError, setCredentialDisconnectError] = useState<string | null>(null);
  const [credentialName, setCredentialName] = useState("");
  const [credentialValues, setCredentialValues] = useState<Record<string, string | number | boolean>>({});
  const [httpAllowedHosts, setHttpAllowedHosts] = useState("");
  const [allTasks, setAllTasks] = useState<TaskView[]>([]);
  const [approvals, setApprovals] = useState<ApprovalView[]>([]);
  const [exceptions, setExceptions] = useState<ExceptionView[]>([]);
  const [selectedExc, setSelectedExc] = useState<ExceptionView | null>(null);
  const [excTab, setExcTab] = useState<"analysis" | "quotes" | "context" | "trace">("analysis");
  const [operationNote, setOperationNote] = useState<string | null>(null);
  const [pendingBizAction, setPendingBizAction] = useState<{ exc: ExceptionView; act: BizAction } | null>(null);
  const [bizActionBusy, setBizActionBusy] = useState(false);
  const [bizActionError, setBizActionError] = useState<string | null>(null);
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifSeen, setNotifSeen] = useState<Set<string>>(new Set());
  // Editor / Runs / Rules / Tests / Versions
  const [editWf, setEditWf] = useState("procurement-orchestrator");
  const [selNodeId, setSelNodeId] = useState<string | null>("router:path");
  const [selEdgeId, setSelEdgeId] = useState<string | null>(null);
  const [editorWorkflows, setEditorWorkflows] = useState<EditorWorkflowDef[]>([]);
  const [editorLibrary, setEditorLibrary] = useState<EditorLibraryGroup[]>([]);
  const [editorNodeTypes, setEditorNodeTypes] = useState<EditorNodeTypeDescriptor[]>([]);
  const [editorRuntime, setEditorRuntime] = useState<EditorRuntimeView | null>(null);
  const [editorVersions, setEditorVersions] = useState<EditorVersionView[]>([]);
  const [editorRuns, setEditorRuns] = useState<EditorRunView[]>([]);
  const [editorRunDetail, setEditorRunDetail] = useState<EditorRunDetail | null>(null);
  const [editorCanvasRunId, setEditorCanvasRunId] = useState<string | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorRunBusy, setEditorRunBusy] = useState<EditorRunMode | "publish" | "rollback" | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [invoiceUpgradePreview, setInvoiceUpgradePreview] = useState<InvoiceMatchUpgradePreview | null>(null);
  const [invoiceUpgradeLoading, setInvoiceUpgradeLoading] = useState(false);
  const [invoiceUpgradeConfirming, setInvoiceUpgradeConfirming] = useState(false);
  const [invoiceUpgradeBusy, setInvoiceUpgradeBusy] = useState(false);
  const [blueprintUpgradePreview, setBlueprintUpgradePreview] = useState<EditorBlueprintUpgradePreview | null>(null);
  const [blueprintUpgradeConfirming, setBlueprintUpgradeConfirming] = useState(false);
  const [blueprintUpgradeBusy, setBlueprintUpgradeBusy] = useState(false);
  const blueprintUpgradeRequestRef = useRef<string | null>(null);
  const [nodeDraft, setNodeDraft] = useState<EditorNodeDraft | null>(null);
  const [nodeParameterDraft, setNodeParameterDraft] = useState<Record<string, string | number | boolean>>({});
  const [edgeDraft, setEdgeDraft] = useState({ label: "", condition: "", sourcePort: "", targetPort: "" });
  const [rulesData, setRulesData] = useState<{ version?: string; createdAt?: string; thresholds: { kind: string; name: string; unit: string; auto: number; buyer: number; note: string; level: string }[]; exceptionTypes: { key: string; id: string }[] } | null>(null);
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, { auto: string; buyer: string }>>({});
  const [testsResult, setTestsResult] = useState<Record<string, { entry: string; workflows: string[]; skipped: string[]; reason: string }>>({});
  const [testRunning, setTestRunning] = useState<string | null>(null);
  const [runFilter, setRunFilter] = useState<"all" | "active" | "done" | "failed">("all");
  const [selRun, setSelRun] = useState<string | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);

  useEffect(() => {
    setEditWf("");
    setSelNodeId(null);
    setSelEdgeId(null);
    setEditorWorkflows([]);
    setEditorLibrary([]);
    setEditorNodeTypes([]);
    setEditorVersions([]);
    setEditorRuns([]);
    setEditorRunDetail(null);
    setEditorCanvasRunId(null);
    setBlueprintUpgradePreview(null);
    setBlueprintUpgradeConfirming(false);
    blueprintUpgradeRequestRef.current = null;
    setRulesData(null);
    setEditorError(null);
  }, [selectedId]);

  const load = useCallback(async () => {
    dashboardRequestRef.current?.abort();
    const controller = new AbortController();
    dashboardRequestRef.current = controller;
    const sequence = ++dashboardSequenceRef.current;
    try {
      const results = await Promise.allSettled([
        apiRequest<unknown>("/api/employees", { signal: controller.signal }),
        apiRequest<Overview>("/api/overview", { signal: controller.signal }),
        apiRequest<OrgData>("/api/org", { signal: controller.signal }),
        apiRequest<ContextData>("/api/context", { signal: controller.signal }),
        section === "tools"
          ? apiRequest<ToolsData>("/api/tools", { signal: controller.signal })
          : Promise.resolve(null),
        apiRequest<TaskView[]>("/api/tasks", { signal: controller.signal }),
        apiRequest<ApprovalView[]>("/api/approvals/pending", { signal: controller.signal }),
        apiRequest<ExceptionView[]>("/api/exceptions", { signal: controller.signal }),
        apiRequest<EventView[]>("/api/events", { signal: controller.signal }),
        selectedId
          ? apiRequest<NonNullable<typeof rulesData>>(employeeScopedPath("/api/rules", selectedId), { signal: controller.signal })
          : Promise.resolve(null),
      ]);
      if (controller.signal.aborted || sequence !== dashboardSequenceRef.current) return;
      const fulfilled = <T,>(index: number): T | undefined => results[index]?.status === "fulfilled" ? results[index].value as T : undefined;
      const empList = fulfilled<unknown>(0);
      const nextEmployees = Array.isArray(empList) ? empList as EmployeeListItem[] : [];
      if (empList !== undefined) setEmployees(nextEmployees);
      const ov = fulfilled<Overview>(1); if (ov) setOverview(ov);
      const orgRes = fulfilled<OrgData>(2); if (orgRes) setOrg(orgRes);
      const ctxRes = fulfilled<ContextData>(3); if (ctxRes) setContext(ctxRes);
      const toolsRes = fulfilled<ToolsData | null>(4); if (toolsRes) setToolsData(toolsRes);
      const taskRes = fulfilled<TaskView[]>(5); if (taskRes) setAllTasks(Array.isArray(taskRes) ? taskRes : []);
      const apprRes = fulfilled<ApprovalView[]>(6); if (apprRes) setApprovals(Array.isArray(apprRes) ? apprRes : []);
      const excRes = fulfilled<ExceptionView[]>(7); if (excRes) setExceptions(Array.isArray(excRes) ? excRes : []);
      const evt = fulfilled<EventView[]>(8); if (evt) setEvents(Array.isArray(evt) ? evt : []);
      const rulesRes = fulfilled<NonNullable<typeof rulesData>>(9); if (rulesRes) setRulesData(rulesRes);
    } finally {
      if (dashboardRequestRef.current === controller) dashboardRequestRef.current = null;
    }
  }, [section, selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    void apiRequest<unknown>("/api/employee-packs", { signal: controller.signal })
      .then((value) => {
        setEmployeePackCatalog(parseEmployeePackCatalog(value));
        setEmployeePackError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setEmployeePackCatalog(null);
        setEmployeePackError(error instanceof Error ? error.message : "员工包清单加载失败");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!employeePackCatalog || employees.length === 0 || employees.some((item) => item.id === selectedId)) return;
    const preferred = preferredEmployeeId(employeePackCatalog, employees.map((item) => item.id));
    if (preferred) setSelectedId(preferred);
  }, [employeePackCatalog, employees, selectedId]);

  const loadConnectors = useCallback(async () => {
    if (!selectedId) return;
    try {
      const [catalog, credentials, activity, readiness] = await Promise.all([
        apiRequest<ConnectorView[]>(employeeScopedPath("/api/editor/connectors", selectedId)),
        apiRequest<{ items: ConnectorCredentialView[] }>(employeeScopedPath("/api/editor/credentials", selectedId)),
        apiRequest<ConnectorEventView[]>(employeeScopedPath("/api/editor/connectors/events?limit=60", selectedId)),
        apiRequest<{ documents?: DocumentReadinessView }>("/api/operations/readiness"),
      ]);
      const nextConnectors = Array.isArray(catalog) ? catalog : [];
      setConnectorsData(nextConnectors);
      setConnectorCredentials(Array.isArray(credentials?.items) ? credentials.items : []);
      setConnectorEvents(Array.isArray(activity) ? activity : []);
      setDocumentReadiness(readiness?.documents ?? null);
      setDocumentReadinessError(null);
      if (nextConnectors.length > 0 && !nextConnectors.some((connector) => connector.id === selectedConnectorId)) setSelectedConnectorId(nextConnectors[0]!.id);
      setConnectorError(null);
    } catch (error) {
      setConnectorError(error instanceof Error ? error.message : "连接器数据加载失败");
      if (error instanceof ReadyworkApiError && error.status >= 500) setDocumentReadinessError("文档运维状态暂时不可用，请刷新重试。");
    }
  }, [selectedConnectorId, selectedId]);

  if (!configurationConnectionsLoader.current) {
    configurationConnectionsLoader.current = createLatestConfigurationConnectionsLoader(
      () => apiRequest<ConfigurationConnectionsPayload>("/api/procurement/configuration/connections"),
      {
        onStart: () => {
          setConfigurationConnectionsLoading(true);
          setConfigurationConnectionsError(null);
          setConfigurationConnectionsManageable(false);
        },
        onSuccess: (response) => {
          setConfigurationConnections(Array.isArray(response.connections) ? response.connections : []);
          setConfigurationAutoSend(response.autoSend ?? null);
          setConfigurationConnectionsManageable(response.permissions?.manage === true);
          setConfigurationConnectionsLoaded(true);
          setConfigurationConnectionsLoading(false);
        },
        onError: (error) => {
          setConfigurationConnectionsError(error instanceof Error ? error.message : "连接状态读取失败");
          setConfigurationConnectionsManageable(false);
          setConfigurationConnectionsLoading(false);
        },
      },
    );
  }

  const loadConfigurationConnections = useCallback(
    () => configurationConnectionsLoader.current?.() ?? Promise.resolve(),
    [],
  );

  const loadEmployee = useCallback(async () => {
    if (!selectedId) { setEmployee(null); return; }
    try {
      const detail = await apiRequest<Employee>(`/api/employees/${selectedId}`);
      if (detail && detail.id) {
        setEmployee(detail as Employee);
        setMode(detail.deployMode as DeployMode);
      }
    } catch { /* 静默 */ }
  }, [selectedId]);

  const loadEditor = useCallback(async () => {
    if (!selectedId) return;
    setEditorLoading(true);
    try {
      const [workflows, catalog, versions, runs, runtime, blueprintPreview] = await Promise.all([
        apiRequest<EditorWorkflowDef[]>(employeeScopedPath("/api/editor/workflows", selectedId)),
        apiRequest<{ groups?: EditorLibraryGroup[]; nodeTypes?: EditorNodeTypeDescriptor[] }>(employeeScopedPath("/api/editor/catalog", selectedId)),
        apiRequest<EditorVersionView[]>(employeeScopedPath("/api/editor/versions", selectedId)),
        apiRequest<EditorRunView[]>(employeeScopedPath("/api/editor/runs?limit=30", selectedId)),
        apiRequest<EditorRuntimeView>(employeeScopedPath("/api/editor/runtime", selectedId)),
        apiRequest<EditorBlueprintUpgradePreview>(employeeScopedPath("/api/editor/blueprint-upgrade", selectedId)),
      ]);
      const nextWorkflows = Array.isArray(workflows) ? workflows as EditorWorkflowDef[] : [];
      setEditorWorkflows(nextWorkflows);
      setEditorLibrary(Array.isArray(catalog?.groups) ? catalog.groups as EditorLibraryGroup[] : []);
      setEditorNodeTypes(Array.isArray(catalog?.nodeTypes) ? catalog.nodeTypes as EditorNodeTypeDescriptor[] : []);
      setEditorVersions(Array.isArray(versions) ? versions as EditorVersionView[] : []);
      setEditorRuns(Array.isArray(runs) ? runs as EditorRunView[] : []);
      setEditorRuntime(runtime as EditorRuntimeView);
      setBlueprintUpgradePreview(blueprintPreview as EditorBlueprintUpgradePreview);
      setBlueprintUpgradeConfirming(false);
      if (nextWorkflows.length && !nextWorkflows.some((workflow) => workflow.id === editWf)) setEditWf(nextWorkflows[0]!.id);
      setEditorError(null);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "编排器数据加载失败");
    } finally {
      setEditorLoading(false);
    }
  }, [editWf, selectedId]);

  const loadInvoiceUpgradePreview = useCallback(async () => {
    if (!selectedId || editWf !== "invoice-match") { setInvoiceUpgradePreview(null); setInvoiceUpgradeConfirming(false); return; }
    setInvoiceUpgradeLoading(true);
    try {
      const preview = await apiRequest<InvoiceMatchUpgradePreview>(employeeScopedPath(`/api/editor/workflows/${encodeURIComponent(editWf)}/invoice-match-upgrade`, selectedId));
      setInvoiceUpgradePreview(preview);
      setInvoiceUpgradeConfirming(false);
    } catch (error) {
      setInvoiceUpgradePreview(null);
      setEditorError(error instanceof Error ? error.message : "行级三单升级预览失败");
    } finally { setInvoiceUpgradeLoading(false); }
  }, [editWf, selectedId]);

  useEffect(() => { void loadInvoiceUpgradePreview(); }, [loadInvoiceUpgradePreview]);

  const upgradeInvoiceMatch = useCallback(async () => {
    if (!invoiceUpgradePreview || invoiceUpgradePreview.status !== "eligible" || invoiceUpgradeBusy) return;
    setInvoiceUpgradeBusy(true);
    try {
      const result = await apiRequest<InvoiceMatchUpgradeResult>(employeeScopedPath(`/api/editor/workflows/${encodeURIComponent(invoiceUpgradePreview.workflowId)}/invoice-match-upgrade`, selectedId), { method: "POST", body: { confirm: true, expectedRevision: invoiceUpgradePreview.currentRevision } });
      setEditorWorkflows((previous) => previous.map((workflow) => workflow.id === result.workflow.id ? result.workflow : workflow));
      setInvoiceUpgradePreview(result.preview);
      setInvoiceUpgradeConfirming(false);
      setOperationNote("已升级为行级三单匹配，草稿已更新");
      window.setTimeout(() => setOperationNote(null), 3600);
      setEditorError(null);
    } catch (error) {
      if (error instanceof ReadyworkApiError && error.status === 409) {
        setEditorError("工作流版本已变化，请刷新后重新预览升级影响。");
        await loadEditor();
        await loadInvoiceUpgradePreview();
      } else setEditorError(error instanceof Error ? error.message : "行级三单升级失败");
    } finally { setInvoiceUpgradeBusy(false); }
  }, [invoiceUpgradeBusy, invoiceUpgradePreview, loadEditor, loadInvoiceUpgradePreview, selectedId]);

  const importV1Blueprint = useCallback(async () => {
    if (!blueprintUpgradePreview || blueprintUpgradePreview.status !== "upgrade_available" || blueprintUpgradeBusy || !selectedId) return;
    setBlueprintUpgradeBusy(true);
    blueprintUpgradeRequestRef.current ??= `employee-pack-blueprint:${crypto.randomUUID()}`;
    try {
      const result = await apiRequest<EditorBlueprintUpgradeResult>(employeeScopedPath("/api/editor/blueprint-upgrade", selectedId), {
        method: "POST",
        body: {
          confirm: true,
          expectedRevisions: blueprintUpgradePreview.expectedRevisions,
          idempotencyKey: blueprintUpgradeRequestRef.current,
        },
      });
      setEditorWorkflows(result.workflows);
      if (result.workflows.length && !result.workflows.some((workflow) => workflow.id === editWf)) setEditWf(result.workflows[0]!.id);
      setBlueprintUpgradeConfirming(false);
      blueprintUpgradeRequestRef.current = null;
      await loadEditor();
      setOperationNote(result.status === "already_current" ? "当前草稿已与 V1 蓝图一致" : "已备份原草稿并导入 V1 蓝图；尚未发布，也未运行任何业务动作");
      window.setTimeout(() => setOperationNote(null), 4200);
      setEditorError(null);
    } catch (error) {
      if (error instanceof ReadyworkApiError && error.status === 409) {
        blueprintUpgradeRequestRef.current = null;
        setEditorError("工作流草稿已变化，请重新核对差异后再导入。");
        await loadEditor();
      } else {
        setEditorError(error instanceof Error ? error.message : "V1 蓝图导入失败");
      }
    } finally {
      setBlueprintUpgradeBusy(false);
    }
  }, [blueprintUpgradeBusy, blueprintUpgradePreview, editWf, loadEditor, selectedId]);

  const loadEditorRunDetail = useCallback(async (runId: string) => {
    try {
      const result = await apiRequest<EditorRunDetail>(employeeScopedPath(`/api/editor/runs/${encodeURIComponent(runId)}`, selectedId));
      const detail = result as EditorRunDetail;
      setEditorRunDetail(detail);
      setEditorRuns((previous) => previous.map((run) => run.id === detail.id ? detail : run));
      setEditorError(null);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "运行详情加载失败");
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => {
      clearInterval(t);
      dashboardRequestRef.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (section === "employees") void loadEmployee();
  }, [section, selectedId, loadEmployee]);

  useEffect(() => {
    if (!publicDemoMode && (section === "tools" || section === "settings") && configurationConnectionsManageable) {
      void loadConnectors();
      return;
    }
    if ((section === "tools" || section === "settings") && !configurationConnectionsLoading) {
      setConnectorsData([]);
      setConnectorCredentials([]);
      setConnectorEvents([]);
      setDocumentReadiness(null);
      setDocumentReadinessError(null);
      setConnectorError(null);
    }
  }, [configurationConnectionsLoading, configurationConnectionsManageable, loadConnectors, publicDemoMode, section]);

  useEffect(() => {
    if (!publicDemoMode && (section === "settings" || section === "tools")) void loadConfigurationConnections();
  }, [section, loadConfigurationConnections, publicDemoMode]);

  useEffect(() => {
    if (!publicDemoMode && viewMode === "developer") void loadEditor();
  }, [viewMode, loadEditor, publicDemoMode]);

  useEffect(() => {
    if (viewMode !== "developer" || !editorRunDetail?.id) return;
    const visibleInRuns = devTab === "runs";
    const visibleOnCanvas = devTab === "editor" && editorCanvasRunId === editorRunDetail.id;
    const active = ["queued", "running", "waiting_approval", "waiting_external"].includes(editorRunDetail.status);
    if ((!visibleInRuns && !visibleOnCanvas) || !active) return;
    const refresh = () => void loadEditorRunDetail(editorRunDetail.id);
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => window.clearInterval(timer);
  }, [devTab, editorCanvasRunId, editorRunDetail?.id, editorRunDetail?.status, loadEditorRunDetail, viewMode]);

  useEffect(() => {
    if (!rulesData) return;
    setRuleDrafts(Object.fromEntries(rulesData.thresholds.map((rule) => [rule.kind, { auto: String(rule.auto), buyer: String(rule.buyer) }])));
  }, [rulesData]);

  const post = useCallback(async (path: string, body: Record<string, unknown>) => {
    await apiRequest(path, { method: "POST", body });
    await Promise.all([load(), section === "employees" ? loadEmployee() : Promise.resolve()]);
  }, [load, loadEmployee, section]);

  const showConnectorNotice = useCallback((message: string) => {
    setOperationNote(message);
    window.setTimeout(() => setOperationNote(null), 3600);
  }, []);

  const runConnectorLifecycle = useCallback(async (connector: ConnectorView, operation: "install" | "enable" | "disable" | "upgrade" | "uninstall") => {
    if (connectorBusy) return;
    setConnectorBusy(`${connector.id}:${operation}`);
    try {
      const allowedHosts = httpAllowedHosts.split(/[,，\n]/).map((host) => host.trim()).filter(Boolean);
      const config = connector.id === "http" ? { allowedHosts } : {};
      if (connector.id === "http" && operation === "install" && allowedHosts.length === 0) throw new Error("请先填写 HTTP 连接器允许访问的主机");
      await apiRequest(employeeScopedPath(`/api/editor/connectors/${encodeURIComponent(connector.id)}/${operation}`, selectedId), { method: "POST", body: { config } });
      await loadConnectors();
      await loadConfigurationConnections();
      showConnectorNotice(`${connector.name}${operation === "install" ? "已安装" : operation === "enable" ? "已启用" : operation === "disable" ? "已停用" : operation === "upgrade" ? "已升级" : "已卸载"}`);
      setConnectorError(null);
    } catch (error) {
      setConnectorError(error instanceof Error ? error.message : "连接器操作失败");
    } finally {
      setConnectorBusy(null);
    }
  }, [connectorBusy, httpAllowedHosts, loadConfigurationConnections, loadConnectors, selectedId, showConnectorNotice]);

  const openCredentialEditor = useCallback((connector: ConnectorView) => {
    const schema = connector.credentialSchemas?.[0];
    if (!schema) {
      setConnectorError("这个连接器不需要单独配置凭据");
      return;
    }
    setCredentialName(`${connector.name}连接`);
    const defaults: Record<string, string | number | boolean> = {};
    for (const field of schema.fields) {
      defaults[field.id] = typeof field.defaultValue === "string" || typeof field.defaultValue === "number" || typeof field.defaultValue === "boolean" ? field.defaultValue : field.type === "boolean" ? false : "";
    }
    setCredentialValues(defaults);
    setCredentialEditorOpen(true);
    setConnectorError(null);
  }, []);

  const focusConnectorConfiguration = useCallback((connectorId: "email" | "whatsapp" | "deepseek" | "erp") => {
    setSelectedConnectorId(connectorId);
    setConnectorQuery("");
    setConnectorCategory("全部");
    window.requestAnimationFrame(() => document.getElementById("connector-catalog")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  const requestConnectorDisconnect = useCallback((connectorId: "email" | "whatsapp" | "deepseek" | "erp") => {
    const credential = connectorCredentials
      .filter((item) => item.connectorId === connectorId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!credential) {
      setConnectorError("没有可断开的已保存凭据");
      return;
    }
    setCredentialDisconnectError(null);
    setCredentialPendingDisconnect(credential);
  }, [connectorCredentials]);

  const saveConnectorCredential = useCallback(async () => {
    const connector = connectorsData.find((item) => item.id === selectedConnectorId);
    const schema = connector?.credentialSchemas?.[0];
    if (!connector || !schema || connectorBusy) return;
    const missing = schema.fields.find((field) => field.required && (credentialValues[field.id] === "" || credentialValues[field.id] === undefined));
    if (missing) {
      setConnectorError(`请填写${missing.label}`);
      return;
    }
    setConnectorBusy(`${connector.id}:credential`);
    try {
      const existing = connectorCredentials.find((credential) => credential.connectorId === connector.id && credential.credentialType === schema.type);
      await apiRequest(employeeScopedPath("/api/editor/credentials", selectedId), {
        method: "POST",
        body: { id: existing?.id ?? `credential:${connector.id}:default`, connectorId: connector.id, credentialType: schema.type, name: credentialName.trim() || `${connector.name}连接`, value: credentialValues },
      });
      setCredentialEditorOpen(false);
      setCredentialValues({});
      await loadConnectors();
      await loadConfigurationConnections();
      showConnectorNotice(`${connector.name}凭据已加密保存`);
      setConnectorError(null);
    } catch (error) {
      setConnectorError(error instanceof Error ? error.message : "凭据保存失败");
    } finally {
      setConnectorBusy(null);
    }
  }, [connectorBusy, connectorCredentials, connectorsData, credentialName, credentialValues, loadConfigurationConnections, loadConnectors, selectedConnectorId, selectedId, showConnectorNotice]);

  const testConnectorCredential = useCallback(async (credential: ConnectorCredentialView) => {
    if (connectorBusy) return;
    setConnectorBusy(`${credential.id}:test`);
    try {
      const result = await apiRequest<{ message: string; checks: { name: string; ok: boolean; message: string }[] }>(employeeScopedPath(`/api/editor/credentials/${encodeURIComponent(credential.id)}/test`, selectedId), { method: "POST" });
      await loadConnectors();
      await loadConfigurationConnections();
      showConnectorNotice(`${result.message}：${result.checks.map((check) => check.name).join("、")}`);
      setConnectorError(null);
    } catch (error) {
      await loadConnectors();
      await loadConfigurationConnections();
      setConnectorError(error instanceof Error ? error.message : "连接测试失败");
    } finally {
      setConnectorBusy(null);
    }
  }, [connectorBusy, loadConfigurationConnections, loadConnectors, selectedId, showConnectorNotice]);

  const disconnectConnectorCredential = useCallback(async () => {
    const credential = credentialPendingDisconnect;
    if (!credential || connectorBusy) return;
    setConnectorBusy(`${credential.id}:disconnect`);
    setCredentialDisconnectError(null);
    try {
      const result = await apiRequest<{ ok: true; connectorId: string; credentialId: string; disconnected: true }>(employeeScopedPath(`/api/editor/credentials/${encodeURIComponent(credential.id)}`, selectedId), { method: "DELETE" });
      await loadConnectors();
      await loadConfigurationConnections();
      setCredentialPendingDisconnect(null);
      showConnectorNotice(`${credential.name}${result.disconnected ? "已断开" : "凭据已删除"}`);
      setConnectorError(null);
    } catch (error) {
      setCredentialDisconnectError(error instanceof Error ? error.message : "断开账号失败");
    } finally {
      setConnectorBusy(null);
    }
  }, [connectorBusy, credentialPendingDisconnect, loadConfigurationConnections, loadConnectors, selectedId, showConnectorNotice]);

  /** 异常工作台的业务动作：批准/驳回/升级走真实 API，未接入动作保持禁用。 */
  const runBizAction = useCallback(async (exc: ExceptionView, act: BizAction) => {
    if (bizActionBusy || act.kind === "unsupported") return;
    setBizActionBusy(true);
    setBizActionError(null);
    try {
      if (act.kind === "approve") await post(`/api/exceptions/${exc.id}/approve`, {});
      else if (act.kind === "reject") await post(`/api/exceptions/${exc.id}/reject`, {});
      else if (act.kind === "reassign") await post(`/api/exceptions/${exc.id}/reassign`, {});
      setPendingBizAction(null);
      setSelectedExc(null);
      setOperationNote(`${act.label}已提交`);
      window.setTimeout(() => setOperationNote(null), 3600);
    } catch (error) {
      setBizActionError(error instanceof Error ? error.message : "操作提交失败，请稍后重试");
    } finally {
      setBizActionBusy(false);
    }
  }, [bizActionBusy, post]);

  const requestBizAction = useCallback((exc: ExceptionView, act: BizAction) => {
    if (act.kind === "unsupported" || bizActionBusy) return;
    setBizActionError(null);
    setPendingBizAction({ exc, act });
  }, [bizActionBusy]);

  /** Editor 四种运行模式由后端分别执行：模拟/影子拦截副作用，审批设门，自动仅允许已发布版本。 */
  const runEditorTest = useCallback(async (runMode: EditorRunMode) => {
    if (editorRunSubmittingRef.current) return;
    editorRunSubmittingRef.current = true;
    const signature = `${selectedId}:${editWf}:${runMode}`;
    if (!editorRunRequestRef.current || editorRunRequestRef.current.signature !== signature) {
      editorRunRequestRef.current = { signature, idempotencyKey: crypto.randomUUID() };
    }
    const idempotencyKey = editorRunRequestRef.current.idempotencyKey;
    setEditorRunBusy(runMode);
    try {
      const result = await apiRequest<EditorRunView & { nodeRuns?: EditorNodeRunView[] }>(employeeScopedPath(`/api/editor/workflows/${encodeURIComponent(editWf)}/run`, selectedId), {
        method: "POST",
        body: { mode: runMode, employeeId: selectedId, idempotencyKey, input: { kind: "event", hasPo: false, hasInvoice: false, hasReceipt: false, hasContractPrice: false } },
      });
      editorRunRequestRef.current = null;
      setEditorRuns((previous) => [result as EditorRunView, ...previous].slice(0, 30));
      setEditorRunDetail({ ...(result as EditorRunView), nodeRuns: Array.isArray(result.nodeRuns) ? result.nodeRuns as EditorNodeRunView[] : [] });
      setEditorCanvasRunId(String(result.id));
      if (runMode === "shadow") setMode("shadow");
      if (runMode === "supervised") setMode("supervised");
      if (runMode === "autonomous") setMode("autonomous");
      setOperationNote(String(result.message));
      window.setTimeout(() => setOperationNote(null), 4200);
      window.setTimeout(() => void loadEditorRunDetail(String(result.id)), 700);
      setEditorError(null);
    } catch (error) {
      if (error instanceof ReadyworkApiError && error.status > 0 && error.status < 500 && error.status !== 408) editorRunRequestRef.current = null;
      const message = error instanceof Error ? error.message : "编排器运行失败";
      setEditorError(message);
      setOperationNote(message);
      window.setTimeout(() => setOperationNote(null), 3200);
    } finally {
      editorRunSubmittingRef.current = false;
      setEditorRunBusy(null);
    }
  }, [editWf, loadEditorRunDetail, selectedId]);

  const actOnEditorRun = useCallback(async (action: "approve" | "reject" | "event" | "cancel") => {
    if (!editorRunDetail) return;
    try {
      await apiRequest(employeeScopedPath(`/api/editor/runs/${encodeURIComponent(editorRunDetail.id)}/${action}`, selectedId), {
        method: "POST",
        body: action === "event" ? { eventType: "external_event", payload: { source: "editor" } } : {},
      });
      setOperationNote(action === "approve" ? "审批信号已发送，Temporal 将从断点恢复" : action === "reject" ? "驳回信号已发送" : action === "event" ? "外部事件已发送，等待节点将恢复" : "运行已取消");
      window.setTimeout(() => setOperationNote(null), 3200);
      window.setTimeout(() => void loadEditorRunDetail(editorRunDetail.id), 300);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "运行操作失败");
    }
  }, [editorRunDetail, loadEditorRunDetail, selectedId]);

  const publishEditor = useCallback(async () => {
    setEditorRunBusy("publish");
    try {
      const result = await apiRequest<{ workflows: EditorWorkflowDef[]; version: EditorVersionView }>(employeeScopedPath("/api/editor/publish", selectedId), { method: "POST", body: { note: `发布 ${employee?.name ?? "AI 员工"} 工作流配置` } });
      setEditorWorkflows(result.workflows as EditorWorkflowDef[]);
      setEditorVersions((previous) => [result.version as EditorVersionView, ...previous.map((version) => ({ ...version, current: false }))]);
      setOperationNote(`已发布 ${result.version.version}`);
      window.setTimeout(() => setOperationNote(null), 3000);
      setEditorError(null);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "发布失败");
    } finally {
      setEditorRunBusy(null);
    }
  }, [employee?.name, selectedId]);

  const rollbackEditor = useCallback(async (versionId: string) => {
    setEditorRunBusy("rollback");
    try {
      const result = await apiRequest<{ workflows: EditorWorkflowDef[]; sourceVersion: string; version: EditorVersionView }>(employeeScopedPath(`/api/editor/versions/${encodeURIComponent(versionId)}/rollback`, selectedId), { method: "POST" });
      setEditorWorkflows(result.workflows as EditorWorkflowDef[]);
      await loadEditor();
      setOperationNote(`已从 ${result.sourceVersion} 恢复并发布为 ${result.version.version}`);
      window.setTimeout(() => setOperationNote(null), 3600);
      setEditorError(null);
    } catch (error) {
      setEditorError(error instanceof Error ? error.message : "回滚失败");
    } finally {
      setEditorRunBusy(null);
    }
  }, [loadEditor, selectedId]);

  const saveRule = useCallback(async (kind: string) => {
    const draft = ruleDrafts[kind];
    if (!draft) return;
    try {
      await apiRequest(employeeScopedPath(`/api/rules/${encodeURIComponent(kind)}`, selectedId), { method: "PUT", body: { auto: Number(draft.auto), buyer: Number(draft.buyer) } });
      await load();
      setOperationNote("审批阈值已保存并立即生效");
      window.setTimeout(() => setOperationNote(null), 2800);
    } catch (error) {
      setOperationNote(error instanceof Error ? error.message : "规则保存失败");
      window.setTimeout(() => setOperationNote(null), 3000);
    }
  }, [load, ruleDrafts, selectedId]);

  /** Tests 页：跑一条真实编排路径 */
  const runTestCase = useCallback(async (id: string, input: Record<string, unknown>) => {
    setTestRunning(id);
    try {
      const d = await apiRequest<{ entry: string; workflows: string[]; skipped: string[]; reason: string }>("/api/orchestrate", { method: "POST", body: input });
      setTestsResult((prev) => ({ ...prev, [id]: d }));
    } catch {
      setTestsResult((prev) => ({ ...prev, [id]: { entry: "error", workflows: [], skipped: [], reason: "编排器不可用" } }));
    } finally {
      setTestRunning(null);
    }
  }, []);

  const setDeployMode = useCallback(async (m: DeployMode) => {
    const previous = mode;
    setMode(m);
    try {
      await post(`/api/employees/${selectedId}/deploy-mode`, { mode: m });
    } catch (error) {
      setMode(previous);
      const message = error instanceof Error ? error.message : "部署模式更新失败";
      setOperationNote(message);
      window.setTimeout(() => setOperationNote(null), 3000);
    }
  }, [mode, post, selectedId]);

  const onEmployeeCreated = useCallback(async (created: { id?: string }) => {
    setShowCreate(false);
    await load();
    if (created && created.id) {
      setSelectedId(created.id);
      setSection("employees");
      await loadEmployee();
    }
  }, [load, loadEmployee]);

  const todayStats = useMemo(() => {
    const tasks = employee?.tasks ?? [];
    return {
      done: tasks.filter((t) => t.status === "completed").length,
      waitingSupplier: tasks.filter((t) => t.status === "waiting_external").length,
      delayed: tasks.filter((t) => t.risk === "中" || t.risk === "高").length,
      waitingApproval: tasks.filter((t) => t.status === "waiting_approval").length,
    };
  }, [employee]);

  const connectorCategories = useMemo(() => ["全部", ...new Set(connectorsData.map((connector) => connector.category ?? "其他"))], [connectorsData]);
  const filteredConnectors = useMemo(() => {
    const query = connectorQuery.trim().toLowerCase();
    return connectorsData.filter((connector) => {
      if (connectorCategory !== "全部" && (connector.category ?? "其他") !== connectorCategory) return false;
      if (!query) return true;
      return [connector.name, connector.description, connector.vendor, ...(connector.tags ?? [])].join(" ").toLowerCase().includes(query);
    });
  }, [connectorCategory, connectorQuery, connectorsData]);
  const selectedConnector = useMemo(() => connectorsData.find((connector) => connector.id === selectedConnectorId) ?? filteredConnectors[0] ?? null, [connectorsData, filteredConnectors, selectedConnectorId]);
  const selectedConnectorCredentials = useMemo(() => connectorCredentials.filter((credential) => credential.connectorId === selectedConnector?.id), [connectorCredentials, selectedConnector?.id]);
  const selectedConnectorEvents = useMemo(() => connectorEvents.filter((event) => event.connectorId === selectedConnector?.id).slice(0, 8), [connectorEvents, selectedConnector?.id]);

  const filteredTasks = useMemo(() => {
    const rows = employee?.tasks ?? [];
    const q = taskQuery.trim().toLowerCase();
    let out = rows;
    if (workFilter === "active") out = rows.filter((t) => t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled");
    else if (workFilter === "waiting") out = rows.filter((t) => t.status.startsWith("waiting"));
    else if (workFilter === "done") out = rows.filter((t) => t.status === "completed");
    else if (workFilter === "failed") out = rows.filter((t) => t.status === "failed");
    if (q) out = out.filter((r) => Object.values(r).join(" ").toLowerCase().includes(q));
    return out;
  }, [taskQuery, workFilter, employee]);

  const activePackBinding = useMemo(() => activeEmployeePack(employeePackCatalog, selectedId), [employeePackCatalog, selectedId]);
  const activePack = activePackBinding?.manifest ?? null;
  const packNavigation = useMemo(() => {
    if (!activePack) return { groups: [], error: null as string | null };
    try {
      return { groups: buildEmployeePackSidebarGroups(activePack, EMPLOYEE_PACK_ICONS), error: null };
    } catch (error) {
      return { groups: [], error: error instanceof Error ? error.message : "员工包导航无效" };
    }
  }, [activePack]);
  const sectionGroups = useMemo(() => packNavigation.groups
    .map((group) => ({ ...group, items: publicDemoMode ? group.items.filter((item) => item.id !== "tools") : group.items }))
    .filter((group) => group.items.length > 0), [packNavigation.groups, publicDemoMode]);
  const packUiError = employeePackError ?? packNavigation.error;

  const empEvents = useMemo(() => events.filter((e) => e.employeeId === selectedId || !e.employeeId).slice(-6), [events, selectedId]);

  /** 异常详情抽屉「执行轨迹」：按业务对象过滤事件流 */
  const excTrace = useMemo(() => {
    if (!selectedExc) return [];
    return events.filter((e) => e.objectId === selectedExc.objectId).slice(-24).reverse();
  }, [events, selectedExc]);

  /** 通知铃铛：任务创建/进入审批/批准/驳回/完成 + 需要你处理的异常（事件流驱动，真实数据） */
  const notifications = useMemo(() => {
    const out: { id: string; at: string; title: string; desc: string; kind: "task" | "exception" }[] = [];
    for (const e of events) {
      let title = "";
      if (e.type === "task.waiting_approval") title = "任务进入审批";
      else if (e.type === "task.created") title = "新任务已创建";
      else if (e.type === "task.approved") title = "审批已通过";
      else if (e.type === "task.rejected") title = "审批被驳回";
      else if (e.type === "task.completed") title = "任务完成";
      else if (e.type === "task.resumed") title = "任务恢复执行";
      else if (e.type === "context.event" && e.eventType === "quote_received") title = "收到供应商报价";
      else if (e.type === "context.event" && e.eventType === "supplier_confirmed") title = "供应商确认交期";
      else if (e.type === "context.event" && e.eventType === "goods_received") title = "货物到货";
      else continue;
      out.push({ id: `${e.at}|${e.type}|${e.objectId ?? ""}|${e.taskId ?? ""}`, at: e.at, title, desc: `${narrateEvent(e)}${e.objectId ? " · " + e.objectId : ""}`, kind: "task" });
    }
    for (const exc of exceptions) out.push({ id: `exc|${exc.id}`, at: exc.createdAt, title: `需要你处理：${exceptionTypeZh(exc.type)}`, desc: `${exc.objectId}${exc.supplier ? " · " + exc.supplier : ""}${exc.item ? " · " + exc.item : ""}`, kind: "exception" });
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
  }, [events, exceptions]);
  const unreadNotifs = notifications.filter((n) => !notifSeen.has(n.id)).length;

  // Editor 画布派生：当前工作流 + 当前选中的节点或连线
  const editWorkflow = editorWorkflows.find((workflow) => workflow.id === editWf) ?? editorWorkflows[0] ?? { id: "", name: "正在加载…", desc: "", nodes: [], edges: [] };
  const editorWorkflowRuns = useMemo(() => editorRuns.filter((run) => run.workflowId === editWorkflow.id), [editWorkflow.id, editorRuns]);
  const editorCanvasRunDetail = editorRunDetail?.id === editorCanvasRunId && editorRunDetail.workflowId === editWorkflow.id ? editorRunDetail : null;
  const editorCanvasRuntimeOverlay = useMemo(() => buildWorkflowRuntimeOverlay(editorCanvasRunDetail), [editorCanvasRunDetail]);
  const selNode = selNodeId ? editWorkflow.nodes.find((nodeItem) => nodeItem.id === selNodeId) : undefined;
  const selectedEdgeIndex = selEdgeId ? editWorkflow.edges.findIndex((edge, index) => (edge.id ?? `edge:${index}:${edge.from}:${edge.to}`) === selEdgeId) : -1;
  const selEdge = selectedEdgeIndex >= 0 ? editWorkflow.edges[selectedEdgeIndex] : undefined;
  const selNodeDescriptor = selNode?.type ? editorNodeTypes.find((descriptor) => descriptor.type === selNode.type && descriptor.version === (selNode.typeVersion ?? 1)) : undefined;

  useEffect(() => {
    if (viewMode !== "developer" || devTab !== "editor") return;
    if (editorWorkflowRuns.length === 0) {
      if (editorCanvasRunId !== null) setEditorCanvasRunId(null);
      return;
    }
    if (editorCanvasRunId && editorWorkflowRuns.some((run) => run.id === editorCanvasRunId)) return;
    const latest = editorWorkflowRuns[0]!;
    setEditorCanvasRunId(latest.id);
    void loadEditorRunDetail(latest.id);
  }, [devTab, editorCanvasRunId, editorWorkflowRuns, loadEditorRunDetail, viewMode]);

  useEffect(() => {
    if (!selNode) { setNodeDraft(null); return; }
    setNodeDraft({
      label: selNode.label, detail: selNode.detail, inputs: (selNode.inputs ?? []).join("，"), outputs: (selNode.outputs ?? []).join("，"),
      permission: selNode.permission ?? "auto", timeoutSeconds: String(Math.round((selNode.timeoutMs ?? 0) / 1000)), retries: String(selNode.retries ?? 0),
      failAction: selNode.failAction ?? "重试后创建系统异常", sideEffects: (selNode.sideEffects ?? []).join("，"), credentialRef: selNode.credentialRef ?? "",
    });
    setNodeParameterDraft(Object.fromEntries((selNodeDescriptor?.parameters ?? []).map((parameter) => {
      const value = selNode.parameters?.[parameter.id] ?? parameter.defaultValue ?? "";
      return [parameter.id, value !== null && typeof value === "object" ? JSON.stringify(value, null, 2) : value as string | number | boolean];
    })));
  }, [selNode, selNodeDescriptor]);

  useEffect(() => {
    if (!selEdge) { setEdgeDraft({ label: "", condition: "", sourcePort: "", targetPort: "" }); return; }
    setEdgeDraft({ label: selEdge.label ?? "", condition: selEdge.condition ?? "", sourcePort: selEdge.sourcePort ?? "", targetPort: selEdge.targetPort ?? "" });
  }, [selEdge]);

  const saveEditorWorkflow = async (next: EditorWorkflowDef, successMessage: string): Promise<EditorWorkflowDef | undefined> => {
    if (!next.id) return undefined;
    setEditorSaving(true);
    try {
      const saved = await apiRequest<EditorWorkflowDef>(employeeScopedPath(`/api/editor/workflows/${encodeURIComponent(next.id)}`, selectedId), { method: "PUT", body: { name: next.name, desc: next.desc, nodes: next.nodes, edges: next.edges, expectedRevision: next.draftRevision } });
      setEditorWorkflows((previous) => previous.map((workflow) => workflow.id === saved.id ? saved as EditorWorkflowDef : workflow));
      setEditorError(null);
      setOperationNote(successMessage);
      window.setTimeout(() => setOperationNote(null), 2400);
      return saved as EditorWorkflowDef;
    } catch (error) {
      const conflict = error instanceof ReadyworkApiError && error.status === 409;
      const message = conflict ? "工作流已被其他会话修改，已刷新最新版本，请重新应用更改" : error instanceof Error ? error.message : "工作流保存失败";
      if (conflict) await loadEditor();
      setEditorError(message);
      setOperationNote(message);
      window.setTimeout(() => setOperationNote(null), 3000);
      return undefined;
    } finally {
      setEditorSaving(false);
    }
  };

  const addEditorNode = async (assetId: string, dropPosition?: { x: number; y: number }): Promise<void> => {
    const asset = editorLibrary.flatMap((group) => group.items).find((item) => item.id === assetId);
    if (!asset || !editWorkflow.id || editorSaving) return;
    const nodeId = `${asset.id}:${Date.now().toString(36)}`;
    const newNode: EditorNodeDef = {
      id: nodeId,
      kind: asset.kind,
      label: asset.label,
      detail: asset.desc,
      type: asset.type,
      typeVersion: asset.typeVersion,
      icon: asset.icon,
      inputs: asset.inputs.map((port) => port.id),
      outputs: asset.outputs.map((port) => port.id),
      parameters: Object.fromEntries(asset.parameters.filter((parameter) => parameter.defaultValue !== undefined).map((parameter) => [parameter.id, parameter.defaultValue])),
      retries: 0,
      permission: asset.kind === "approval" ? "manager" : "auto",
      failAction: "重试后创建系统异常",
      sideEffects: asset.sideEffects,
      position: dropPosition ?? (() => {
        const anchorNode = selNodeId ? editWorkflow.nodes.find((item) => item.id === selNodeId) : editWorkflow.nodes.at(-1);
        return anchorNode?.position ? { x: anchorNode.position.x + 304, y: anchorNode.position.y } : { x: 80 + editWorkflow.nodes.length * 40, y: 120 + editWorkflow.nodes.length * 28 };
      })(),
    };
    const anchor = selNodeId && editWorkflow.nodes.some((item) => item.id === selNodeId) ? selNodeId : editWorkflow.nodes.at(-1)?.id;
    const next = { ...editWorkflow, nodes: [...editWorkflow.nodes, newNode], edges: anchor ? [...editWorkflow.edges, { from: anchor, to: nodeId }] : editWorkflow.edges };
    const saved = await saveEditorWorkflow(next, `已将「${asset.label}」加入 ${editWorkflow.name}`);
    if (saved) { setSelEdgeId(null); setSelNodeId(nodeId); }
  };

  const commitEditorGraph = async (nodes: CanvasNodeDefinition[], edges: CanvasEdgeDefinition[], message: string): Promise<boolean> => {
    const saved = await saveEditorWorkflow({ ...editWorkflow, nodes: nodes as EditorNodeDef[], edges: edges as EditorEdgeDef[] }, message);
    return Boolean(saved);
  };

  const saveSelectedEdge = async (): Promise<void> => {
    if (!selEdge || selectedEdgeIndex < 0 || editorSaving) return;
    const updated: EditorEdgeDef = {
      ...selEdge,
      label: edgeDraft.label.trim() || undefined,
      condition: edgeDraft.condition.trim() || undefined,
      sourcePort: edgeDraft.sourcePort.trim() || undefined,
      targetPort: edgeDraft.targetPort.trim() || undefined,
    };
    const edges = editWorkflow.edges.map((edge, index) => index === selectedEdgeIndex ? updated : edge);
    await saveEditorWorkflow({ ...editWorkflow, edges }, "连线配置已保存");
  };

  const deleteSelectedEdge = async (): Promise<void> => {
    if (!selEdge || selectedEdgeIndex < 0 || editorSaving) return;
    const edges = editWorkflow.edges.filter((_edge, index) => index !== selectedEdgeIndex);
    const saved = await saveEditorWorkflow({ ...editWorkflow, edges }, "连线已删除");
    if (saved) setSelEdgeId(null);
  };

  const saveSelectedNode = async (): Promise<void> => {
    if (!selNode || !nodeDraft || editorSaving) return;
    const split = (value: string) => value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
    const parameters = Object.fromEntries((selNodeDescriptor?.parameters ?? []).map((parameter) => {
      const raw = nodeParameterDraft[parameter.id];
      if (parameter.control === "number") return [parameter.id, Number(raw) || 0];
      if (parameter.control === "boolean") return [parameter.id, Boolean(raw)];
      if (parameter.control === "json" && typeof raw === "string") {
        try { return [parameter.id, JSON.parse(raw) as unknown]; } catch { return [parameter.id, raw]; }
      }
      return [parameter.id, raw ?? ""];
    }));
    const updated: EditorNodeDef = {
      ...selNode, label: nodeDraft.label.trim(), detail: nodeDraft.detail.trim(), inputs: split(nodeDraft.inputs), outputs: split(nodeDraft.outputs),
      permission: nodeDraft.permission, timeoutMs: Math.max(0, Number(nodeDraft.timeoutSeconds) || 0) * 1000, retries: Math.max(0, Math.floor(Number(nodeDraft.retries) || 0)),
      failAction: nodeDraft.failAction.trim(), sideEffects: split(nodeDraft.sideEffects), parameters, credentialRef: nodeDraft.credentialRef.trim() || undefined,
    };
    await saveEditorWorkflow({ ...editWorkflow, nodes: editWorkflow.nodes.map((item) => item.id === updated.id ? updated : item) }, `节点「${updated.label}」已保存`);
  };

  // Runs 页派生
  const filteredRuns = allTasks.filter((t) => runFilter === "all" ? true : runFilter === "active" ? (t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled") : runFilter === "done" ? t.status === "completed" : t.status === "failed");
  const selRunEvents = selRun ? events.filter((e) => e.taskId === selRun).slice(-24).reverse() : [];

  const businessTabs: { id: BusinessTab; label: string }[] = [
    { id: "overview", label: "概览" }, { id: "work", label: "工作" }, { id: "capability", label: "能力" },
    { id: "permission", label: "权限" }, { id: "context", label: "上下文" }, { id: "performance", label: "绩效" }, { id: "settings", label: "设置" },
  ];
  const devTabs: { id: DevTab; label: string }[] = [
    { id: "editor", label: "编排" }, { id: "runs", label: "运行" }, { id: "rules", label: "规则" },
    { id: "tests", label: "测试" }, { id: "versions", label: "版本" }, { id: "logs", label: "日志" },
  ];

  const navigateToSection = useCallback((destination: Section, options?: { purchaseOrderId?: string | null; purchaseOrderIntent?: PurchaseOrderNavigationIntent | null; returnTo?: Section | null; replace?: boolean; viewMode?: EmployeePackViewMode }) => {
    if (typeof window !== "undefined") resetNavigationScroll(window);
    if (destination === "orders") {
      const purchaseOrderId = purchaseOrderIdFromUrl(options?.purchaseOrderId ?? null);
      const requestedReturn = options?.returnTo ?? (section === "orders" ? purchaseOrderReturnTo : section);
      const returnTarget = requestedReturn && requestedReturn !== "orders" ? requestedReturn : "home";
      setInitialPurchaseOrderId(purchaseOrderId);
      setInitialPurchaseOrderTab("overview");
      setInitialPurchaseOrderIntent(options?.purchaseOrderIntent ?? null);
      setPurchaseOrderReturnTo(returnTarget);
      setViewMode("business");
      setSection("orders");
      writeNavigationUrl("orders", purchaseOrderId, returnTarget, options?.replace ? "replace" : "push", "overview", "business", options?.purchaseOrderIntent ?? null);
      return;
    }
    const nextViewMode = destination === "employees" ? options?.viewMode ?? viewMode : "business";
    setInitialPurchaseOrderId(null);
    setInitialPurchaseOrderTab("overview");
    setInitialPurchaseOrderIntent(null);
    setPurchaseOrderReturnTo(null);
    setViewMode(nextViewMode);
    setSection(destination);
    writeNavigationUrl(destination, null, null, options?.replace ? "replace" : "push", null, nextViewMode);
  }, [purchaseOrderReturnTo, section, viewMode]);

  useEffect(() => {
    if (!activePack) return;
    const resolved = resolveEmployeePackSection(activePack, section, viewMode);
    if (!resolved.redirected) return;
    navigateToSection(resolved.section, { replace: true });
  }, [activePack, navigateToSection, section, viewMode]);

  const openWorkflowEditor = useCallback(() => {
    if (publicDemoMode) return;
    const employeeId = activePackBinding?.employeeIds.includes(selectedId)
      ? selectedId
      : activePackBinding?.manifest.defaultEmployeeId ?? activePackBinding?.employeeIds[0] ?? "";
    if (!employeeId || !activePackBinding?.manifest.interfaces.developer.enabled) return;
    setSelectedId(employeeId);
    setDevTab("editor");
    navigateToSection("employees", { viewMode: "developer" });
  }, [activePackBinding, navigateToSection, publicDemoMode, selectedId]);

  useEffect(() => {
    if (!publicDemoMode || viewMode !== "developer") return;
    setViewMode("business");
    writeNavigationUrl(section, null, null, "replace", null, "business");
  }, [publicDemoMode, section, viewMode]);

  const clearInvalidPurchaseOrderTarget = useCallback((purchaseOrderId: string) => {
    setInitialPurchaseOrderId((current) => current === purchaseOrderId ? null : current);
    setInitialPurchaseOrderIntent(null);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("section") === "orders" && purchaseOrderIdFromUrl(url.searchParams.get("poId")) === purchaseOrderId) {
      writeNavigationUrl("orders", null, purchaseOrderReturnTo ?? "home", "replace", "overview");
    }
  }, [purchaseOrderReturnTo]);

  const consumeInitialPurchaseOrderTarget = useCallback(() => {
    const purchaseOrderId = initialPurchaseOrderId;
    const intent = initialPurchaseOrderIntent;
    setInitialPurchaseOrderId(null);
    setInitialPurchaseOrderIntent(null);
    if (intent && purchaseOrderId) writeNavigationUrl("orders", purchaseOrderId, purchaseOrderReturnTo ?? "home", "replace", initialPurchaseOrderTab);
  }, [initialPurchaseOrderId, initialPurchaseOrderIntent, initialPurchaseOrderTab, purchaseOrderReturnTo]);

  const updatePurchaseOrderNavigation = useCallback((purchaseOrderId: string, detailTab: PoDetailTabId) => {
    setInitialPurchaseOrderTab(detailTab);
    writeNavigationUrl("orders", purchaseOrderIdFromUrl(purchaseOrderId), purchaseOrderReturnTo ?? "home", "replace", detailTab);
  }, [purchaseOrderReturnTo]);

  const legacySectionTitle: Record<Section, string> = {
    workbench: "采购执行工作台", home: "总览", notifications: "通知", "message-drafts": "沟通草稿", "po-intake": "邮箱 PO 待核验", "local-procurement": "本地采购", "import-procurement": "进口采购", "risk-dashboard": "风险看板", sla: "服务等级", "advanced-sla": "高级服务等级", "my-work": "待我处理", orders: "采购订单", sourcing: "寻源与询价", suppliers: "供应商", payables: "发票与应付", logistics: "物流与交付", documents: "文档", "ai-records": "AI 工作记录", settings: "设置与连接", overview: "总览", org: "组织", employees: "AI 员工", requisitions: "采购需求", rfq: "询价与报价", tasks: "任务", approvals: "审批", context: "上下文", tools: "工具与连接",
  };
  const packSectionTitles = new Map(sectionGroups.flatMap((group) => group.items.map((item) => [item.id, item.label] as const)));
  const currentSectionTitle = packSectionTitles.get(section) ?? legacySectionTitle[section];
  const tenantName = org?.tenants[0]?.name ?? "当前租户";
  const selectedOrgEmployee = org?.employees.find((item) => item.id === selectedId);
  const activeDepartment = org?.departments.find((department) => department.id === selectedOrgEmployee?.deptId)?.name ?? "—";
  const procurementSection = activePack?.branding.themeId === "readywork-procurement" && activePack.interfaces.business.ownedSectionIds.includes(section);
  const purchaseOrderIdInUrl = typeof window === "undefined"
    ? initialPurchaseOrderId
    : purchaseOrderIdFromUrl(new URL(window.location.href).searchParams.get("poId"));
  const procurementHeader = procurementHeaderPresentation({ section, purchaseOrderId: purchaseOrderIdInUrl });
  const navigateFromProcurementHeader = (destination: ProcurementHeaderTarget, objectId?: string | null) => {
    navigateToSection(destination, destination === "orders" ? { purchaseOrderId: objectId, returnTo: section } : undefined);
  };

  return (
    <div className={cn("min-h-screen overflow-x-clip text-slate-950", procurementSection ? "bg-[#f8fafc]" : "bg-slate-50")}>
      <div className="flex min-h-screen">
        <aside
          className="sticky top-0 hidden h-screen shrink-0 flex-col transition-[width] ease-[cubic-bezier(.16,1,.3,1)] lg:flex"
          style={{
            width: sidebarOpen ? READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarExpandedPx : READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarCollapsedPx,
            padding: READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarOuterPaddingPx,
            transitionDuration: `${READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarTransitionMs}ms`,
          }}
        >
          <div
            className="flex h-full min-h-0 flex-col overflow-hidden border border-[#e2e8f0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_1px_3px_rgba(15,23,42,0.05)]"
            style={{ borderRadius: READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarPanelRadiusPx }}
          >
            <div
              className={cn("flex shrink-0 items-center gap-2.5 px-4", !sidebarOpen && "justify-center px-0")}
              style={{ height: READYWORK_PROCUREMENT_VISUAL_TOKENS.sidebarHeaderHeightPx }}
            >
              <div className={cn("flex shrink-0 items-center justify-center rounded-[9px] text-white shadow-sm", procurementSection ? "bg-[#2563eb] shadow-blue-200" : "bg-slate-950", sidebarOpen ? "size-[30px]" : "size-[34px]")}><Command className="size-4" /></div>
              {sidebarOpen && <div className="min-w-0"><div className="truncate text-[17px] font-bold tracking-[-0.02em] text-[#0f172a]">{!activePack?.branding.productName || /^(?:Readywork|READYWORK)$/.test(activePack.branding.productName) ? "SupplySentry" : activePack.branding.productName}</div></div>}
            </div>
            <div className="mx-3 h-px shrink-0 bg-[#eef2f7]" />
            <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
              {sectionGroups.map((group) => <div key={group.id} className="space-y-1">{group.label && group.id !== "work" && <div className={cn("px-3 pb-1 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-400", !sidebarOpen && "sr-only")}>{group.label}</div>}<div className="space-y-1">{group.items.map((item) => { const Icon = item.icon; return <button key={item.id} onClick={() => navigateToSection(item.id)} className={cn("relative flex w-full items-center gap-3 rounded-xl px-3 py-2 text-[13.5px] font-medium transition-colors duration-200", section === item.id ? procurementSection ? "bg-[#2563eb] text-white shadow-[0_6px_16px_-6px_rgba(37,99,235,0.6)]" : "bg-slate-950 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100 hover:text-slate-950", !sidebarOpen && "justify-center px-0")}><Icon className="size-[18px] shrink-0" strokeWidth={2} />{sidebarOpen && <span className="flex-1 truncate text-left">{item.label}</span>}</button>; })}</div></div>)}
              {packUiError && sidebarOpen && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[11px] leading-5 text-red-700">{packUiError}</div>}
            </nav>
            <div className="mx-3 h-px shrink-0 bg-[#eef2f7]" />
            <div className={cn("flex shrink-0 items-center gap-2 px-4 py-3.5", !sidebarOpen && "flex-col px-0")}>
              {sidebarOpen && <div className="min-w-0 flex-1"><div data-preserve-language className="truncate text-[11px] font-medium text-slate-500">{tenantName}</div><div data-preserve-language className="truncate text-[10.5px] text-slate-400">{activeDepartment}</div></div>}
              <button type="button" aria-label={sidebarOpen ? "收起导航" : "展开导航"} onClick={() => setSidebarOpen((v) => !v)} className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-[#e2e8f0] bg-white text-slate-500 shadow-sm transition-colors hover:bg-slate-100 hover:text-slate-900">
                {sidebarOpen ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
              </button>
            </div>
          </div>
        </aside>

        <main className="relative min-w-0 flex-1">
          {procurementSection ? <ProcurementGlobalHeader title={currentSectionTitle} onNavigate={navigateFromProcurementHeader} integrated={procurementHeader.integrated} showSearch={procurementHeader.showSearch} /> : <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-slate-200 bg-white/85 px-4 backdrop-blur-xl md:px-6">
            <div className="flex items-center gap-3">
              <div className="hidden items-center gap-2 text-xs text-slate-400 sm:flex">
                <span>SupplySentry</span>
                <span>/</span>
                {section === "employees" ? (
                  <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 outline-none">
                    {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                ) : (
                  <span className="font-medium text-slate-700">{currentSectionTitle}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <LanguageSwitcher />
              {section === "employees" && (
                <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 p-1">
                  {([["business", "业务视图"], ["developer", "开发者视图"]] as [ViewMode, string][]).map(([id, label]) => (
                    <button key={id} onClick={() => id === "developer" ? openWorkflowEditor() : navigateToSection(sectionFromNavigationValue(activePack?.interfaces.business.defaultSectionId) ?? "home")} className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition", viewMode === id ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900")}>{label}</button>
                  ))}
                </div>
              )}
              <div className="relative">
                <Button variant="ghost" size="icon" className="relative" onClick={() => { setNotifOpen((v) => !v); setNotifSeen((s) => new Set([...s, ...notifications.map((n) => n.id)])); }}>
                  <Bell className="size-4" />
                  {unreadNotifs > 0 && <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-semibold text-white">{unreadNotifs > 9 ? "9+" : unreadNotifs}</span>}
                </Button>
                {notifOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
                    <div className="absolute right-0 top-12 z-50 w-[340px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                        <div className="text-sm font-semibold">通知</div>
                        <button onClick={() => setNotifSeen(new Set(notifications.map((n) => n.id)))} className="text-[11px] text-slate-400 hover:text-slate-600">全部标为已读</button>
                      </div>
                      <div className="max-h-[380px] overflow-y-auto">
                        {notifications.length === 0 ? (
                          <div className="p-8 text-center text-xs text-slate-400">暂无通知</div>
                        ) : notifications.slice(0, 20).map((n) => (
                          <div key={n.id} className={cn("flex items-start gap-2.5 border-b border-slate-50 px-4 py-2.5", notifSeen.has(n.id) ? "" : "bg-blue-50/40")}>
                            <div className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", n.kind === "exception" ? "bg-red-500" : "bg-blue-500")} />
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-medium text-slate-800">{n.title}</div>
                              <div className="mt-0.5 truncate text-[11px] text-slate-400">{n.desc}</div>
                            </div>
                            <div className="shrink-0 text-[10px] text-slate-300">{n.at.slice(5, 16)}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
              {(["employees", "org", "context", "tools"] as Section[]).includes(section) && <Button onClick={() => setShowCreate(true)}><Plus className="size-4" /><span className="hidden sm:inline">创建 AI 员工</span></Button>}
            </div>
          </header>}

          <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 lg:hidden" aria-label={`${activePack?.branding.employeeSubtitle ?? "AI 员工"}导航`}>
            {sectionGroups.flatMap((group) => group.items).map((item) => <button key={item.id} type="button" onClick={() => navigateToSection(item.id)} className={cn("min-h-9 shrink-0 rounded-lg px-3 text-xs font-medium", section === item.id ? "bg-[#2563eb] text-white" : "text-slate-600 hover:bg-slate-100")}>{item.label}</button>)}
          </nav>

          <div className={cn(
            procurementSection
                ? purchaseOrderIdInUrl ? "w-full px-4 pb-6 pt-[18px] md:pl-7 md:pr-[33px]" : "w-full px-4 py-6 md:px-7"
                : "mx-auto max-w-[1680px] px-4 py-6 md:px-6 md:py-8",
          )}>
            {/* ─────────── 总览 ─────────── */}
            {section === "workbench" && <ProcurementWorkbench onNavigate={(destination) => navigateToSection(destination)} />}
            {section === "home" && <ProcurementHomeDashboard onNavigate={(destination, purchaseOrderId, intent) => navigateToSection(destination, destination === "orders" ? { purchaseOrderId, purchaseOrderIntent: intent === "view" ? null : intent, returnTo: "home" } : undefined)} />}
            {section === "notifications" && <ProcurementNotifications onNavigate={(destination, objectId) => navigateToSection(destination, destination === "orders" ? { purchaseOrderId: objectId, returnTo: "notifications" } : undefined)} />}
            {section === "message-drafts" && <ProcurementMessageDrafts onOpenSla={() => navigateToSection("sla")} onOpenSettings={() => navigateToSection("settings")} onOpenPurchaseOrder={(purchaseOrderId) => navigateToSection("orders", { purchaseOrderId, returnTo: "message-drafts" })} />}
            {section === "po-intake" && <ProcurementPoIntake onOpenOrder={(poId) => navigateToSection("orders", { purchaseOrderId: poId, returnTo: "po-intake" })} />}
            {section === "local-procurement" && <ProcurementRouteWorkbench route="local" onOpenOrder={(purchaseOrderId) => navigateToSection("orders", { purchaseOrderId, returnTo: "local-procurement" })} onOpenMessageDrafts={() => navigateToSection("message-drafts")} />}
            {section === "import-procurement" && <ProcurementRouteWorkbench route="import" onOpenOrder={(purchaseOrderId) => navigateToSection("orders", { purchaseOrderId, returnTo: "import-procurement" })} onOpenMessageDrafts={() => navigateToSection("message-drafts")} />}
            {section === "risk-dashboard" && <ProcurementRiskDashboard onOpenPurchaseOrder={(purchaseOrderId) => navigateToSection("orders", { purchaseOrderId, returnTo: "risk-dashboard" })} onViewAllSuppliers={() => navigateToSection("suppliers")} onViewAllHighRiskPurchaseOrders={() => navigateToSection("orders", { returnTo: "risk-dashboard" })} />}
            {section === "sla" && <ProcurementSlaWorkbench />}
            {section === "advanced-sla" && <ProcurementAdvancedSlaWorkbench />}
            {section === "my-work" && <ProcurementOperations mode="my-work" onNavigate={(destination) => navigateToSection(destination)} />}
            {section === "payables" && <ProcurementApWorkbench />}
            {section === "logistics" && <ProcurementOperations mode="logistics" />}
            {section === "sourcing" && <ProcurementRfqs onCreateRequisition={() => navigateToSection("requisitions")} />}
            {section === "orders" && <ProcurementPoEmployee onCreateTask={() => navigateToSection("requisitions")} initialPurchaseOrderId={initialPurchaseOrderId} initialPurchaseOrderIntent={initialPurchaseOrderIntent} initialDetailTab={initialPurchaseOrderTab} onInitialPurchaseOrderConsumed={consumeInitialPurchaseOrderTarget} onInitialPurchaseOrderInvalid={clearInvalidPurchaseOrderTarget} onPurchaseOrderNavigationChange={updatePurchaseOrderNavigation} onReturn={() => navigateToSection(purchaseOrderReturnTo ?? "home")} returnLabel={packSectionTitles.get(purchaseOrderReturnTo ?? "home") ?? legacySectionTitle[purchaseOrderReturnTo ?? "home"]} onOpenSettings={() => navigateToSection("settings")} />}
            {section === "suppliers" && <ProcurementSuppliersWorkbench onOpenPurchaseOrder={(purchaseOrderId) => navigateToSection("orders", { purchaseOrderId, returnTo: "suppliers" })} />}
            {section === "documents" && <ProcurementDomainSection mode="documents" />}
            {section === "ai-records" && <ProcurementDomainSection mode="ai-records" />}
            {section === "overview" && overview && (
              <div className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  <StatCard label="AI 员工" value={String(overview.employees.total)} change="在线" icon={Bot} />
                  <StatCard label="当前活跃任务" value={String(overview.activeTasks)} change="实时" icon={Activity} />
                  <StatCard label="待审批" value={String(overview.tasks.pendingApprovals)} change="待处理" icon={ShieldCheck} />
                  <StatCard label="本月 AI 成本" value={money(overview.totalCost)} change="预算内" icon={CircleDollarSign} />
                  <StatCard label="自动完成率" value={pct(overview.autoRate)} change="KPI" icon={Zap} />
                </div>
                <div className="grid gap-5 xl:grid-cols-3">
                  <Card>
                    <CardHeader><div><CardTitle>员工状态</CardTitle><CardDescription>AI 员工队伍运行分布。</CardDescription></div></CardHeader>
                    <CardContent className="space-y-3 pt-4">
                      {Object.entries(overview.employees.byStatus).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between rounded-xl border border-slate-200 p-3">
                          <Badge tone={toneForStatus(k)}>{platformStatusZh(k)}</Badge>
                          <span className="text-lg font-semibold">{v}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader><div><CardTitle>任务状态</CardTitle><CardDescription>业务任务分布。</CardDescription></div></CardHeader>
                    <CardContent className="space-y-3 pt-4">
                      {Object.entries(overview.tasks.byStatus).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between rounded-xl border border-slate-200 p-3">
                          <Badge tone={toneForStatus(k)}>{platformStatusZh(k)}</Badge>
                          <span className="text-lg font-semibold">{v}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader><div><CardTitle>按部门</CardTitle><CardDescription>各部门 AI 员工数量。</CardDescription></div></CardHeader>
                    <CardContent className="space-y-3 pt-4">
                      {Object.entries(overview.employees.byDepartment).map(([k, v]) => (
                        <div key={k} className="flex items-center justify-between rounded-xl border border-slate-200 p-3">
                          <span className="text-sm text-slate-700">{k}</span>
                          <span className="text-lg font-semibold">{v}</span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                </div>
                <Card>
                  <CardHeader><div><CardTitle>最近事件</CardTitle><CardDescription>全域领域事件流。</CardDescription></div></CardHeader>
                  <CardContent className="max-h-72 overflow-auto pt-4">
                    <div className="space-y-1">
                      {events.slice(-40).reverse().map((e, i) => (
                        <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:bg-slate-50">
                          <span className="font-mono text-slate-400">{e.at.slice(11, 19)}</span>
                          <span className={cn("size-1.5 rounded-full", eventTone(e.type))} />
                          <span className="text-slate-700">{eventLabel(e.type)}</span>
                          <span className="flex-1 truncate text-slate-400">{e.reason ?? e.taskId ?? ""}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {section === "requisitions" && <ProcurementRequisitions onNavigateToSourcing={() => setSection("sourcing")} />}
            {section === "rfq" && <ProcurementRfqs />}

            {/* ─────────── 组织 ─────────── */}
            {section === "org" && org && (
              <div className="space-y-5">
                <div className="grid gap-5 xl:grid-cols-2">
                  <Card>
                    <CardHeader><div><CardTitle>部门</CardTitle><CardDescription>组织架构。</CardDescription></div></CardHeader>
                    <CardContent className="pt-4">
                      <table className="w-full border-separate border-spacing-0 text-left text-sm">
                        <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400"><th className="border-b border-slate-100 px-3 py-2 font-medium">部门</th><th className="border-b border-slate-100 px-3 py-2 font-medium">AI 员工</th><th className="border-b border-slate-100 px-3 py-2 font-medium">人类员工</th></tr></thead>
                        <tbody>{org.departments.map((d) => <tr key={d.id}><td className="border-b border-slate-100 px-3 py-2.5 font-medium">{d.name}</td><td className="border-b border-slate-100 px-3 py-2.5">{d.aiCount}</td><td className="border-b border-slate-100 px-3 py-2.5">{d.humanCount}</td></tr>)}</tbody>
                      </table>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader><div><CardTitle>人类员工</CardTitle><CardDescription>审批人与协作角色。</CardDescription></div></CardHeader>
                    <CardContent className="pt-4">
                      <table className="w-full border-separate border-spacing-0 text-left text-sm">
                        <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400"><th className="border-b border-slate-100 px-3 py-2 font-medium">姓名</th><th className="border-b border-slate-100 px-3 py-2 font-medium">角色</th><th className="border-b border-slate-100 px-3 py-2 font-medium">邮箱</th></tr></thead>
                        <tbody>{org.humans.map((h) => <tr key={h.id}><td className="border-b border-slate-100 px-3 py-2.5 font-medium">{h.name}</td><td className="border-b border-slate-100 px-3 py-2.5 text-slate-600">{h.role}</td><td className="border-b border-slate-100 px-3 py-2.5 text-slate-500">{h.email}</td></tr>)}</tbody>
                      </table>
                    </CardContent>
                  </Card>
                </div>
                <Card>
                  <CardHeader><div><CardTitle>AI 员工</CardTitle><CardDescription>点击进入员工详情。</CardDescription></div></CardHeader>
                  <CardContent className="pt-4">
                    <table className="w-full border-separate border-spacing-0 text-left text-sm">
                      <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400"><th className="border-b border-slate-100 px-3 py-2 font-medium">员工</th><th className="border-b border-slate-100 px-3 py-2 font-medium">岗位</th><th className="border-b border-slate-100 px-3 py-2 font-medium">状态</th><th className="border-b border-slate-100 px-3 py-2 font-medium"></th></tr></thead>
                      <tbody>
                        {org.employees.map((e) => (
                          <tr key={e.id} className="cursor-pointer hover:bg-slate-50" onClick={() => { setSelectedId(e.id); setSection("employees"); }}>
                            <td className="border-b border-slate-100 px-3 py-2.5 font-medium">{e.name}</td>
                            <td className="border-b border-slate-100 px-3 py-2.5 text-slate-600">{e.role.slice(0, 30)}</td>
                            <td className="border-b border-slate-100 px-3 py-2.5"><Badge tone={toneForStatus(e.status)}>{e.statusZh}</Badge></td>
                            <td className="border-b border-slate-100 px-3 py-2.5 text-right"><ArrowRight className="inline size-3.5 text-slate-400" /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* ─────────── 任务 ─────────── */}
            {section === "tasks" && (
              <div className="space-y-5">
              <CollaborationPanel />
              <Card>
                <CardHeader>
                  <div><CardTitle>任务</CardTitle><CardDescription>全部 AI 员工的业务任务。</CardDescription></div>
                  <div className="relative w-full max-w-64">
                    <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
                    <input value={taskQuery} onChange={(e) => setTaskQuery(e.target.value)} placeholder="搜索订单/供应商" className="h-9 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-3 text-xs outline-none focus:border-slate-400" />
                  </div>
                </CardHeader>
                <CardContent className="overflow-x-auto pt-4">
                  <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left text-sm">
                      <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400"><th className="border-b border-slate-100 px-3 py-3 font-medium">任务</th><th className="border-b border-slate-100 px-3 py-3 font-medium">工作流</th><th className="border-b border-slate-100 px-3 py-3 font-medium">订单</th><th className="border-b border-slate-100 px-3 py-3 font-medium">供应商</th><th className="border-b border-slate-100 px-3 py-3 font-medium">状态</th><th className="border-b border-slate-100 px-3 py-3 font-medium">风险</th><th className="border-b border-slate-100 px-3 py-3 font-medium">下一步</th></tr></thead>
                      <tbody>
                        {allTasks.filter((t) => !taskQuery || Object.values(t).join(" ").toLowerCase().includes(taskQuery.toLowerCase())).map((row) => (
                          <tr key={row.id} className="cursor-pointer hover:bg-slate-50">
                          <td className="border-b border-slate-100 px-3 py-3.5 font-mono text-xs">{row.id.slice(0, 12)}</td>
                          <td className="border-b border-slate-100 px-3 py-3.5 text-slate-600">{row.workflowId}</td>
                          <td className="border-b border-slate-100 px-3 py-3.5 font-medium">{row.businessObjectId}</td>
                          <td className="border-b border-slate-100 px-3 py-3.5 text-slate-600">{row.supplier}</td>
                          <td className="border-b border-slate-100 px-3 py-3.5"><Badge tone={toneForStatus(row.status)}>{row.statusZh}</Badge></td>
                          <td className="border-b border-slate-100 px-3 py-3.5"><span className={cn("text-xs font-medium", row.risk === "高" ? "text-red-600" : row.risk === "中" ? "text-amber-600" : "text-emerald-600")}>{row.risk}</span></td>
                          <td className="border-b border-slate-100 px-3 py-3.5 text-slate-500">{row.next}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
              </div>
            )}

            {/* ─────────── 审批 · 异常工作台 ─────────── */}
            {section === "approvals" && (
              <Card>
                <CardHeader>
                  <div>
                    <CardTitle>审批 · 异常工作台</CardTitle>
                    <CardDescription>AI 已自动处理正常事项，仅向你提交超出权限或需要业务判断的异常。</CardDescription>
                    <p className="mt-1.5 text-[11px] text-slate-400">AI 生成内容可能不准确，请核对后再确认。所有状态变更操作（接受/拒绝/重新分配）需你确认后生效。</p>
                  </div>
                  <Badge tone={exceptions.length ? "red" : "green"}>{exceptions.length} 项待处理</Badge>
                </CardHeader>
                <CardContent className="space-y-4 pt-4">
                  {exceptions.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 p-10 text-center">
                      <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-600"><CheckCircle2 className="size-5" /></div>
                      <p className="mt-3 text-sm font-medium text-slate-600">当前没有需要你处理的异常</p>
                      <p className="mt-1 text-xs text-slate-400">AI 已自动处理正常事项，如有新异常会出现在这里。</p>
                    </div>
                  ) : exceptions.map((exc) => {
                    const risk = exceptionRiskZh(exc.severity);
                    const acts = exceptionActions(exc.type);
                    const impact = exceptionImpact(exc);
                    const ctxBlock = exceptionContextBlock(exc);
                    const c = (exc.context ?? {}) as Record<string, unknown>;
                    const amount = exc.amount ?? exc.threeWay?.po?.amount ?? Number(c["amount"] ?? 0);
                    return (
                      <div
                        key={exc.id}
                        onClick={() => { setSelectedExc(exc); setExcTab("analysis"); }}
                        className="group cursor-pointer rounded-2xl border border-slate-200 p-5 transition hover:border-blue-300 hover:shadow-sm"
                      >
                        {/* 第一层：发生了什么 */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600"><AlertTriangle className="size-5" /></div>
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-base font-semibold text-slate-950">{exceptionTypeZh(exc.type)}</span>
                                <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{exc.objectId}</span>
                              </div>
                              <div className="mt-1 text-xs text-slate-500">
                                {exc.supplier ?? ""}{exc.item ? " · " + exc.item : ""}
                                {amount ? <span className="text-slate-400"> ｜ 采购金额 <span className="font-medium text-slate-700">¥{amount.toLocaleString()}</span></span> : null}
                              </div>
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <Badge tone={risk.tone}>{risk.label}</Badge>
                            <div className="mt-1 max-w-44 text-right text-[11px] leading-4 text-slate-400">{risk.reason}</div>
                          </div>
                        </div>

                        {/* 第二层：为什么需要你处理 */}
                        <div className="mt-4">
                          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400"><Sparkles className="size-3" />为什么需要你处理</div>
                          <p className="mt-1.5 text-sm leading-6 text-slate-700">{exc.aiJudgment}</p>
                        </div>

                        {/* 第三层：关键上下文（真正把 PO/收货/发票/报价表露出来） */}
                        {ctxBlock && (
                          <div className="mt-4">
                            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">关键上下文</div>
                            <div className="mt-1.5">{ctxBlock}</div>
                          </div>
                        )}

                        {/* 第四层：业务影响 */}
                        <div className="mt-4">
                          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">业务影响</div>
                          <div className="mt-1.5 grid grid-cols-2 gap-2 md:grid-cols-4">
                            {impact.map((im, i) => (
                              <div key={i} className="rounded-xl bg-slate-50 px-3 py-2.5">
                                <div className="text-[11px] text-slate-400">{im.label}</div>
                                <div className={`mt-0.5 text-sm font-semibold ${im.tone ?? "text-slate-800"}`}>{im.value}</div>
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* 第五层：AI 建议（独立区域 + 置信度）+ 业务化动作 */}
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-xs font-semibold text-blue-900">
                              <Bot className="size-3.5" />AI 建议
                              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-700">置信度 {Math.round((exc.confidence ?? 0.85) * 100)}%</span>
                            </div>
                            <p className="mt-1 text-sm text-blue-800">{exc.recommendedAction}</p>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button size="sm" onClick={(e) => { e.stopPropagation(); requestBizAction(exc, acts.main); }}><Check className="size-3.5" />{acts.main.label}</Button>
                            {acts.secondary.slice(0, 2).map((a) => (
                              <Button key={a.label} variant="outline" size="sm" disabled={a.kind === "unsupported"} title={a.kind === "unsupported" ? a.hint : undefined} onClick={(e) => { e.stopPropagation(); requestBizAction(exc, a); }}>{a.label}{a.kind === "unsupported" ? "（尚未接入）" : ""}</Button>
                            ))}
                            {acts.more.length > 0 && (
                              <span className="flex items-center gap-1 rounded-lg px-2 text-[11px] text-slate-400" title="更多操作尚未接入后端"><MoreHorizontal className="size-4" />尚未接入</span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            )}

            {/* ─────────── 上下文 ─────────── */}
            {section === "context" && context && (
              <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
                <Card>
                  <CardHeader><div><CardTitle>知识实体</CardTitle><CardDescription>企业上下文图谱中的实体。</CardDescription></div></CardHeader>
                  <CardContent className="pt-4">
                    <table className="w-full border-separate border-spacing-0 text-left text-sm">
                      <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400"><th className="border-b border-slate-100 px-3 py-2 font-medium">类型</th><th className="border-b border-slate-100 px-3 py-2 font-medium">实体</th><th className="border-b border-slate-100 px-3 py-2 font-medium">属性</th></tr></thead>
                      <tbody>{context.entities.map((e) => (
                        <tr key={e.id}><td className="border-b border-slate-100 px-3 py-2.5"><Badge tone="blue">{e.type}</Badge></td><td className="border-b border-slate-100 px-3 py-2.5 font-mono text-xs">{e.id}</td><td className="border-b border-slate-100 px-3 py-2.5 text-xs text-slate-500">{JSON.stringify(e.attributes).slice(0, 80)}</td></tr>
                      ))}</tbody>
                    </table>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><div><CardTitle>关系</CardTitle><CardDescription>实体之间的业务关系。</CardDescription></div></CardHeader>
                  <CardContent className="space-y-2 pt-4">
                    {context.relationships.map((r, i) => (
                      <div key={i} className="flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-xs">
                        <span className="font-mono text-slate-600">{r.from}</span>
                        <Badge tone="violet">{r.type}</Badge>
                        <span className="font-mono text-slate-600">{r.to}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </div>
            )}

            {/* ─────────── 工具与连接 ─────────── */}
            {(section === "tools" || section === "settings") && (
              <ProcurementConfigurationWorkbench
                mode={section === "settings" ? "settings" : "tools"}
                publicDemo={publicDemoMode}
                connections={configurationConnections}
                autoSend={configurationAutoSend}
                connectionsManageable={configurationConnectionsManageable}
                loading={configurationConnectionsLoading}
                error={configurationConnectionsError}
                connectionSourceLoaded={configurationConnectionsLoaded}
                onOpenConnector={focusConnectorConfiguration}
                onDisconnectConnector={requestConnectorDisconnect}
                onNavigate={(target) => navigateToSection(target)}
              >
                <Card id="connector-control-plane" className="scroll-mt-24 overflow-hidden border-slate-900 bg-slate-950 text-white">
                  <CardContent className="grid gap-5 p-5 lg:grid-cols-[1fr_auto] lg:items-center">
                    <div>
                      <div className="flex items-center gap-2 text-xs font-medium text-slate-400"><Blocks className="size-4" />连接器控制面</div>
                      <h2 className="mt-3 text-xl font-semibold tracking-tight">企业系统连接中心</h2>
                      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">统一管理连接器声明、加密凭据、安装生命周期和隔离运行。AI 员工只获得被授权的业务动作，不直接接触账号密码。</p>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        ["连接器", String(connectorsData.length)],
                        ["已安装", String(connectorsData.filter((connector) => connector.status === "installed").length)],
                        ["外部已验证", String(connectorsData.filter((connector) => connector.externalVerified).length)],
                        ["加密凭据", String(connectorCredentials.length)],
                      ].map(([label, value]) => <div key={label} className="min-w-24 rounded-xl border border-white/10 bg-white/5 px-3 py-3"><div className="text-lg font-semibold">{value}</div><div className="mt-1 text-[10px] text-slate-400">{label}</div></div>)}
                    </div>
                  </CardContent>
                </Card>

                {connectorError && <div className="flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700"><span>{connectorError}</span><button onClick={() => setConnectorError(null)}><X className="size-4" /></button></div>}

                <Card id="document-gate" className="scroll-mt-24">
                  <CardHeader>
                    <div><CardTitle>文档处理与外发门禁</CardTitle><CardDescription>来自生产运维接口的真实队列、安全扫描和外发状态。</CardDescription></div>
                    <Badge tone={documentReadiness?.pendingMalwareScan || documentReadiness?.quarantined || documentReadiness?.scanFailed ? "amber" : documentReadiness ? "green" : "neutral"}>
                      {documentReadiness ? (documentReadiness.pendingMalwareScan || documentReadiness.quarantined || documentReadiness.scanFailed ? "需要处理" : "运行正常") : "未读取"}
                    </Badge>
                  </CardHeader>
                  <CardContent className="space-y-3 pt-4">
                    {documentReadinessError && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{documentReadinessError}</div>}
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
                      {[
                        ["待解析", documentReadiness?.queued], ["处理中", documentReadiness?.processing], ["已完成", documentReadiness?.completed], ["解析失败", documentReadiness?.failed],
                        ["租约过期", documentReadiness?.expiredLeases], ["待扫描", documentReadiness?.pendingMalwareScan], ["已隔离", documentReadiness?.quarantined], ["扫描失败", documentReadiness?.scanFailed],
                      ].map(([label, value]) => <div key={label} className="rounded-xl bg-slate-50 px-3 py-2.5"><div className="text-[10px] text-slate-400">{label}</div><div className="mt-1 text-lg font-semibold text-slate-900">{typeof value === "number" ? value : "—"}</div></div>)}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 px-3 py-2.5 text-xs">
                      <span className="text-slate-500">外发门禁：<span className="font-medium text-slate-800">{documentReadiness?.externalSendGate === "requires-security-status-clean" ? "仅允许安全状态为 clean 的附件" : documentReadiness?.externalSendGate ?? "未提供"}</span></span>
                      <span className="text-slate-400">待扫描、隔离或扫描失败的附件不会进入邮件发送</span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="rounded-xl border border-slate-100 px-3 py-2.5 text-xs">
                        <div className="flex items-center justify-between gap-2"><span className="font-medium text-slate-700">附件存储</span><Badge tone={documentReadiness?.storage?.status === "unavailable" ? "red" : documentReadiness?.storage ? "green" : "neutral"}>{documentReadiness?.storage?.backend === "s3" ? "S3 / MinIO" : documentReadiness?.storage?.backend === "sqlite" ? "本地 SQLite" : "未读取"}</Badge></div>
                        <div className="mt-1 text-slate-400">完整性校验：{documentReadiness?.storage?.integrityVerification ? "SHA-256 + 大小" : "未确认"} · 加密：{documentReadiness?.storage?.encryption ?? "未提供"}</div>
                      </div>
                      <div className="rounded-xl border border-slate-100 px-3 py-2.5 text-xs">
                        <div className="flex items-center justify-between gap-2"><span className="font-medium text-slate-700">恶意软件扫描</span><Badge tone={documentReadiness?.malwareScanner?.status === "ready" ? "green" : documentReadiness?.malwareScanner ? "amber" : "neutral"}>{documentReadiness?.malwareScanner?.engine === "clamd" ? "ClamAV daemon" : documentReadiness?.malwareScanner?.engine === "clamscan" ? "ClamAV 命令行" : "未读取"}</Badge></div>
                        <div className="mt-1 text-slate-400">{documentReadiness?.malwareScanner?.status === "ready" ? "已验证可用" : documentReadiness?.malwareScanner?.configured ? "已配置，尚未在本页探测" : "未配置；附件将保持待扫描并禁止外发"}</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <div id="security-events" className="scroll-mt-24"><ProcurementSecurityEventsPanel /></div>

                <div id="connector-catalog" className="scroll-mt-24 grid gap-5 xl:grid-cols-[minmax(0,1fr)_390px]">
                  <Card>
                    <CardHeader>
                      <div><CardTitle>连接器目录</CardTitle><CardDescription>内置能力与隔离插件使用同一份声明和运行接口。</CardDescription></div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative"><Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" /><input value={connectorQuery} onChange={(event) => setConnectorQuery(event.target.value)} placeholder="搜索 ERP、邮箱、WMS…" className="h-9 w-56 rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-xs outline-none focus:border-slate-400" /></div>
                        <select value={connectorCategory} onChange={(event) => setConnectorCategory(event.target.value)} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs outline-none">
                          {connectorCategories.map((category) => <option key={category} value={category}>{category}</option>)}
                        </select>
                      </div>
                    </CardHeader>
                    <CardContent className="grid gap-3 pt-4 md:grid-cols-2 2xl:grid-cols-3">
                      {filteredConnectors.map((connector) => {
                        const active = selectedConnector?.id === connector.id;
                        const credential = connectorCredentials.find((item) => item.connectorId === connector.id);
                        return (
                          <button key={connector.id} onClick={() => setSelectedConnectorId(connector.id)} className={cn("min-h-44 rounded-2xl border p-4 text-left transition", active ? "border-slate-900 bg-slate-50 shadow-sm ring-1 ring-slate-900" : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm")}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex size-10 items-center justify-center rounded-xl bg-slate-100 text-slate-700"><Plug className="size-4" /></div>
                              <Badge tone={connector.implementationMode === "reference" ? "neutral" : connector.status === "installed" && connector.externalVerified ? "green" : connector.status === "failed" ? "red" : connector.status === "disabled" ? "neutral" : "amber"}>{connectorStatusZh[connector.status]}</Badge>
                            </div>
                            <div className="mt-4 flex items-center gap-2"><span className="text-sm font-semibold text-slate-900">{connector.name}</span><Badge tone="neutral">{connector.category ?? "其他"}</Badge>{connector.implementationMode === "reference" && <Badge tone="neutral">参考实现</Badge>}</div>
                            <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{connector.description}</p>
                            <div className="mt-3 flex items-center justify-between text-[10px] text-slate-400"><span>{connectorRuntimeZh[connector.runtime]}</span><span>{credential ? credentialStatusZh[credential.status] : connector.credentialSchemas?.length ? "未配置凭据" : "无需凭据"}</span></div>
                          </button>
                        );
                      })}
                      {filteredConnectors.length === 0 && <div className="col-span-full rounded-2xl border border-dashed border-slate-200 py-12 text-center text-sm text-slate-400">没有匹配的连接器</div>}
                    </CardContent>
                  </Card>

                  <Card className="h-fit xl:sticky xl:top-5">
                    {selectedConnector ? <>
                      <CardHeader>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2"><CardTitle>{selectedConnector.name}</CardTitle><Badge tone={selectedConnector.implementationMode === "reference" ? "neutral" : selectedConnector.status === "installed" && selectedConnector.externalVerified ? "green" : selectedConnector.status === "failed" ? "red" : "amber"}>{connectorStatusZh[selectedConnector.status]}</Badge>{selectedConnector.implementationMode === "reference" && <Badge tone="neutral">参考实现</Badge>}</div>
                          <CardDescription>{selectedConnector.vendor} · v{selectedConnector.version} · {connectorRuntimeZh[selectedConnector.runtime]}</CardDescription>
                        </div>
                        <div className="flex size-10 items-center justify-center rounded-xl bg-slate-100"><Settings className="size-4" /></div>
                      </CardHeader>
                      <CardContent className="space-y-5 pt-4">
                        <p className="text-xs leading-5 text-slate-600">{selectedConnector.description}</p>
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div className="rounded-xl bg-slate-50 p-3"><div className="text-slate-400">运行状态</div><div className="mt-1 font-medium text-slate-800">{selectedConnector.healthMessage ?? (selectedConnector.healthy ? "运行正常" : "尚未启动")}</div></div>
                          <div className="rounded-xl bg-slate-50 p-3"><div className="text-slate-400">凭据数量</div><div className="mt-1 font-medium text-slate-800">{selectedConnector.credentialCount}</div></div>
                        </div>

                        {selectedConnector.id === "http" && selectedConnector.status !== "installed" && <label className="block text-[11px] font-medium text-slate-600">允许访问的主机<input value={httpAllowedHosts} onChange={(event) => setHttpAllowedHosts(event.target.value)} placeholder="api.customer.com, 10.0.0.8" className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 px-3 text-xs font-normal outline-none focus:border-slate-400" /></label>}

                        <div className="flex flex-wrap gap-2">
                          {selectedConnector.status === "installed" && <Button size="sm" variant="outline" disabled={Boolean(connectorBusy)} onClick={() => void runConnectorLifecycle(selectedConnector, "disable")}>停用</Button>}
                          {selectedConnector.status === "disabled" && <Button size="sm" disabled={Boolean(connectorBusy)} onClick={() => void runConnectorLifecycle(selectedConnector, "enable")}>启用</Button>}
                          {(selectedConnector.status === "available" || selectedConnector.status === "failed") && <Button size="sm" disabled={Boolean(connectorBusy)} onClick={() => void runConnectorLifecycle(selectedConnector, "install")}>{connectorBusy === `${selectedConnector.id}:install` ? "安装中…" : "安装插件"}</Button>}
                          {selectedConnector.status === "installed" && selectedConnector.distribution !== "builtin" && <Button size="sm" variant="outline" disabled={Boolean(connectorBusy)} onClick={() => void runConnectorLifecycle(selectedConnector, "upgrade")}>升级</Button>}
                          {(selectedConnector.credentialSchemas?.length ?? 0) > 0 && <Button size="sm" variant={selectedConnectorCredentials.length ? "outline" : "default"} onClick={() => openCredentialEditor(selectedConnector)}><KeyRound className="size-3.5" />{selectedConnectorCredentials.length ? "重新配置凭据" : "配置凭据"}</Button>}
                        </div>

                        <div>
                          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">凭据</div>
                          <div className="space-y-2">
                            {selectedConnectorCredentials.map((credential) => <div key={credential.id} className="rounded-xl border border-slate-200 p-3">
                              <div className="flex items-center justify-between gap-3"><div className="min-w-0"><div className="truncate text-xs font-medium text-slate-800">{credential.name}</div><div className="mt-1 text-[10px] text-slate-400">{credential.credentialType}</div></div><Badge tone={credential.status === "connected" ? "green" : credential.status === "failed" ? "red" : "amber"}>{credentialStatusZh[credential.status]}</Badge></div>
                              {credential.lastError && <div className="mt-2 text-[10px] leading-4 text-red-600">{credential.lastError}</div>}
                              <div className="mt-3 flex flex-wrap gap-2">
                                <Button size="sm" variant="outline" disabled={Boolean(connectorBusy)} onClick={() => void testConnectorCredential(credential)}>{connectorBusy === `${credential.id}:test` ? "测试中…" : "测试连接"}</Button>
                                <Button size="sm" variant="danger" disabled={Boolean(connectorBusy)} onClick={() => { setCredentialPendingDisconnect(credential); setCredentialDisconnectError(null); }}><Unplug className="size-3.5" />{selectedConnector.id === "whatsapp" ? "断开账号" : "删除凭据"}</Button>
                              </div>
                            </div>)}
                            {selectedConnectorCredentials.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400">{selectedConnector.credentialSchemas?.length ? "尚未配置凭据" : "此连接器不需要凭据"}</div>}
                          </div>
                        </div>

                        <div>
                          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">可用动作</div>
                          <div className="space-y-2">{selectedConnector.actions.map((action) => <div key={action.id} className="rounded-xl border border-slate-200 px-3 py-2.5"><div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-slate-800">{action.name}</span><Badge tone={action.risk === "read" || action.risk === "low" ? "green" : action.risk === "medium" ? "amber" : "red"}>{action.risk === "read" ? "只读" : action.risk}</Badge></div><div className="mt-1 text-[10px] leading-4 text-slate-400">{action.id} · {action.description}</div></div>)}</div>
                        </div>
                      </CardContent>
                    </> : <CardContent className="py-16 text-center text-sm text-slate-400">请选择连接器</CardContent>}
                  </Card>
                </div>

                <div className="grid gap-5 lg:grid-cols-2">
                  <Card>
                    <CardHeader><div><CardTitle>运行事件</CardTitle><CardDescription>安装、凭据和连接测试都会留下可审计记录。</CardDescription></div></CardHeader>
                    <CardContent className="space-y-2 pt-4">
                      {selectedConnectorEvents.map((event) => <div key={event.seq} className="flex items-start gap-3 rounded-xl border border-slate-100 px-3 py-2.5"><div className={cn("mt-1 size-2 rounded-full", event.status === "success" ? "bg-emerald-500" : "bg-red-500")} /><div className="min-w-0 flex-1"><div className="text-xs text-slate-700">{event.message}</div><div className="mt-1 text-[10px] text-slate-400">{event.eventType} · {formatDateTime(event.createdAt)}</div></div></div>)}
                      {selectedConnectorEvents.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-xs text-slate-400">暂无运行事件</div>}
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader><div><CardTitle>员工可调用工具</CardTitle><CardDescription>连接器动作经过权限与副作用网关后，才会暴露给 AI 员工。</CardDescription></div></CardHeader>
                    <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
                      {(toolsData?.tools ?? []).map((tool) => <div key={tool.id} className="rounded-xl border border-slate-200 p-3"><div className="flex items-center justify-between"><span className="text-xs font-semibold text-slate-800">{tool.name}</span><Badge tone={tool.connected ? "green" : tool.implementationMode === "reference" ? "neutral" : "amber"}>{tool.connected ? "已连接" : tool.implementationMode === "reference" ? "参考实现" : "未连接"}</Badge></div><div className="mt-2 flex flex-wrap gap-1">{tool.actions.map((action) => <Badge key={action} tone="neutral">{action}</Badge>)}</div></div>)}
                    </CardContent>
                  </Card>
                </div>

                {credentialEditorOpen && selectedConnector && selectedConnector.credentialSchemas?.[0] && <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm" onMouseDown={() => setCredentialEditorOpen(false)}>
                  <div className="max-h-[86vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
                    <div className="flex items-start justify-between gap-4"><div><div className="text-base font-semibold">配置 {selectedConnector.name}</div><div className="mt-1 text-xs text-slate-500">保存后只显示凭据名称和测试状态，敏感字段不会返回浏览器。</div></div><button onClick={() => setCredentialEditorOpen(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><X className="size-4" /></button></div>
                    <label className="mt-5 block text-xs font-medium text-slate-700">连接名称<input name="readywork-credential-display-name" value={credentialName} onChange={(event) => setCredentialName(event.target.value)} autoComplete="off" data-1p-ignore="true" data-lpignore="true" data-form-type="other" className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 px-3 text-xs font-normal outline-none focus:border-slate-400" /></label>
                    <div className="mt-4 space-y-4">{selectedConnector.credentialSchemas[0].fields.map((field, fieldIndex) => <label key={field.id} className="block text-xs font-medium text-slate-700">{field.label}{field.required && <span className="ml-1 text-red-500">*</span>}
                      {field.type === "boolean" ? <input type="checkbox" checked={Boolean(credentialValues[field.id])} onChange={(event) => setCredentialValues((values) => ({ ...values, [field.id]: event.target.checked }))} className="ml-3 align-middle" /> : field.type === "select" ? <select value={String(credentialValues[field.id] ?? "")} onChange={(event) => setCredentialValues((values) => ({ ...values, [field.id]: event.target.value }))} className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-xs font-normal outline-none">{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input name={`readywork-connector-field-${fieldIndex}`} type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"} value={String(credentialValues[field.id] ?? "")} onChange={(event) => setCredentialValues((values) => ({ ...values, [field.id]: field.type === "number" ? Number(event.target.value) : event.target.value }))} placeholder={field.placeholder} autoComplete={field.type === "password" ? "new-password" : "off"} data-1p-ignore="true" data-lpignore="true" data-form-type="other" className="mt-1.5 h-9 w-full rounded-lg border border-slate-200 px-3 text-xs font-normal outline-none focus:border-slate-400" />}
                      {field.description && <span className="mt-1 block text-[10px] font-normal text-slate-400">{field.description}</span>}
                    </label>)}</div>
                    <div className="mt-6 flex justify-end gap-2"><Button variant="outline" onClick={() => setCredentialEditorOpen(false)}>取消</Button><Button disabled={Boolean(connectorBusy)} onClick={() => void saveConnectorCredential()}><KeyRound className="size-4" />{connectorBusy ? "保存中…" : "加密保存"}</Button></div>
                  </div>
                </div>}

                {credentialPendingDisconnect && <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="credential-disconnect-title" onMouseDown={() => { if (!connectorBusy) { setCredentialPendingDisconnect(null); setCredentialDisconnectError(null); } }}>
                  <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
                    <div className="flex items-start gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600"><Unplug className="size-5" /></div>
                      <div className="min-w-0">
                        <h2 id="credential-disconnect-title" className="text-base font-semibold text-slate-950">{credentialPendingDisconnect.connectorId === "whatsapp" ? "断开 WhatsApp 账号" : credentialPendingDisconnect.connectorId === "email" ? "断开企业邮箱" : "断开 ERP 连接"}</h2>
                        <p className="mt-1 text-sm leading-5 text-slate-600">将从 Readywork 删除「{credentialPendingDisconnect.name}」的加密凭据，并立即停止使用此连接。</p>
                      </div>
                    </div>
                    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800">
                      {credentialPendingDisconnect.connectorId === "whatsapp" ? "此操作不会撤销 Meta 端的 WhatsApp Business 账号，也不会删除历史消息或审计记录。如需彻底撤销访问，请同时在 Meta Business Manager 中撤销令牌。" : "历史运行事件和审计记录会保留；此操作不会修改外部系统中的账号或业务数据。"}
                    </div>
                    {credentialDisconnectError && <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700" role="alert">{credentialDisconnectError}</div>}
                    <div className="mt-5 flex justify-end gap-2">
                      <Button variant="outline" disabled={Boolean(connectorBusy)} onClick={() => { setCredentialPendingDisconnect(null); setCredentialDisconnectError(null); }}>取消</Button>
                      <Button variant="danger" disabled={Boolean(connectorBusy)} onClick={() => void disconnectConnectorCredential()}><Unplug className="size-4" />{connectorBusy === `${credentialPendingDisconnect.id}:disconnect` ? "正在断开…" : "确认断开"}</Button>
                    </div>
                  </div>
                </div>}
              </ProcurementConfigurationWorkbench>
            )}

            {/* ─────────── AI 员工详情 ─────────── */}
            {section === "employees" && (employee ? (
              <>
                <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-7">
                  <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                    <div className="flex min-w-0 gap-4">
                      <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white shadow-sm"><Bot className="size-5" /></div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{employee.name}</h1>
                          <Badge tone={employee.status === "failed" ? "red" : mode === "autonomous" ? "green" : "blue"}><span className="mr-1.5 size-1.5 rounded-full bg-current" />{mode === "autonomous" ? "自主运行" : mode === "supervised" ? "受监督运行" : "影子观察"}</Badge>
                          <Badge tone="violet">AI 员工 · {employee.version}</Badge>
                        </div>
                        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">{employee.role}</p>
                        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500">
                          <span className="flex items-center gap-1.5"><UsersRound className="size-3.5" />{employee.deptName}</span>
                          <span className="flex items-center gap-1.5"><Network className="size-3.5" />直属经理：{employee.managerName}</span>
                          <span className="flex items-center gap-1.5"><CircleDollarSign className="size-3.5" />预算 {employee.budget?.monthlyCap ?? "—"} {employee.budget?.currency ?? ""}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {activePack?.lifecycle && (
                    <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-4">
                      <div className="mb-4 flex items-center justify-between gap-4">
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">V1 生命周期</div>
                          <div className="mt-1 text-sm font-semibold text-slate-900">PO 发出至最终 GRN</div>
                        </div>
                        <Badge tone="blue">桌面 Web · {activePack.version}</Badge>
                      </div>
                      <ol className="grid grid-cols-5 gap-0" aria-label="采购订单执行生命周期">
                        {activePack.lifecycle.stages.map((stage, index) => (
                          <li key={stage.id} className="relative min-w-0 pr-3 last:pr-0">
                            {index < activePack.lifecycle!.stages.length - 1 && <div className="absolute left-7 right-0 top-3 h-px bg-slate-300" />}
                            <div className="relative flex size-6 items-center justify-center rounded-full border border-slate-300 bg-white text-[10px] font-semibold text-slate-700 shadow-sm">{index + 1}</div>
                            <div className="mt-2 truncate text-[11px] font-semibold text-slate-800" title={stage.label}>{stage.label}</div>
                            <p className="mt-1 line-clamp-2 pr-2 text-[10px] leading-4 text-slate-500" title={stage.description}>{stage.description}</p>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  <div className="mt-6 overflow-x-auto border-t border-slate-100 pt-4">
                    <div className="flex min-w-max gap-1">
                      {viewMode === "business"
                        ? businessTabs.map((item) => (
                          <button key={item.id} onClick={() => setTab(item.id)} className={cn("rounded-xl px-3.5 py-2 text-sm font-medium transition", tab === item.id ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-950")}>{item.label}</button>
                        ))
                        : devTabs.map((item) => (
                          <button key={item.id} onClick={() => setDevTab(item.id)} className={cn("rounded-xl px-3.5 py-2 text-sm font-medium transition", devTab === item.id ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-950")}>{item.label}</button>
                        ))}
                    </div>
                  </div>
                </section>

                {viewMode === "business" && (
                  <>
                    {tab === "overview" && (
                      <div className="mt-5 space-y-5">
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                          <StatCard label="今日已处理订单" value={String(todayStats.done)} change="实时" icon={PackageCheck} />
                          <StatCard label="等待供应商" value={String(todayStats.waitingSupplier)} change="进行中" icon={Clock3} />
                          <StatCard label="发现延期" value={String(todayStats.delayed)} change={todayStats.delayed ? "需关注" : "正常"} icon={AlertTriangle} />
                          <StatCard label="等待你审批" value={String(todayStats.waitingApproval)} change="待处理" icon={ShieldCheck} />
                          <StatCard label="自动完成率" value={pct(employee.kpi.successRate)} change="KPI" icon={Zap} />
                        </div>
                        <div className="grid gap-5 2xl:grid-cols-[minmax(0,1.35fr)_minmax(380px,.65fr)]">
                          <Card>
                            <CardHeader><div><CardTitle>当前工作</CardTitle><CardDescription>这个员工现在手上正在跟进的业务。</CardDescription></div></CardHeader>
                            <CardContent className="overflow-x-auto pt-4">
                              <table className="w-full min-w-[560px] border-separate border-spacing-0 text-left">
                                <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400"><th className="border-b border-slate-100 px-3 py-3 font-medium">订单</th><th className="border-b border-slate-100 px-3 py-3 font-medium">供应商</th><th className="border-b border-slate-100 px-3 py-3 font-medium">状态</th><th className="border-b border-slate-100 px-3 py-3 font-medium">风险</th><th className="border-b border-slate-100 px-3 py-3 font-medium">下一步</th></tr></thead>
                                <tbody>
                                  {filteredTasks.map((row) => (
                                    <tr key={row.id} className="cursor-pointer text-sm hover:bg-slate-50">
                                      <td className="border-b border-slate-100 px-3 py-3.5 font-medium text-slate-900">{row.businessObjectId}</td>
                                      <td className="border-b border-slate-100 px-3 py-3.5 text-slate-600">{row.supplier}</td>
                                      <td className="border-b border-slate-100 px-3 py-3.5"><Badge tone={toneForStatus(row.status)}>{row.statusZh}</Badge></td>
                                      <td className="border-b border-slate-100 px-3 py-3.5"><span className={cn("text-xs font-medium", row.risk === "高" ? "text-red-600" : row.risk === "中" ? "text-amber-600" : "text-emerald-600")}>{row.risk}</span></td>
                                      <td className="border-b border-slate-100 px-3 py-3.5 text-slate-500">{row.next}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </CardContent>
                          </Card>
                          <Card>
                            <CardHeader><div><CardTitle>实时执行轨迹</CardTitle><CardDescription>{employee.approvals[0] ? "当前等待人工审批" : "最近任务执行轨迹"}</CardDescription></div></CardHeader>
                            <CardContent className="pt-5">
                              <div className="space-y-0">
                                {empEvents.map((event, index) => (
                                  <div key={event.at + event.type + index} className="relative flex gap-3 pb-5 last:pb-0">
                                    {index !== empEvents.length - 1 && <div className="absolute left-[7px] top-5 h-[calc(100%-8px)] w-px bg-slate-200" />}
                                    <div className={cn("mt-1 size-[15px] shrink-0 rounded-full border-4 border-white ring-1 ring-slate-200", eventTone(event.type))} />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center justify-between gap-3">
                                        <div className="text-sm font-medium text-slate-900">{narrateEvent(event)}</div>
                                        <div className="text-[11px] text-slate-400">{event.at.slice(11, 19)}</div>
                                      </div>
                                      {event.objectId && <p className="mt-1 text-xs font-mono text-slate-400">{event.objectId}</p>}
                                      {event.reason && event.type !== "context.event" && <p className="mt-1 text-xs leading-5 text-slate-500">{event.reason}</p>}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </CardContent>
                          </Card>
                        </div>
                        <Card>
                          <CardHeader><div><CardTitle>待你审批</CardTitle><CardDescription>只有超出员工权限边界的决策才需要你介入。</CardDescription></div><Badge tone={employee.approvals.length ? "amber" : "green"}>{employee.approvals.length} 项待处理</Badge></CardHeader>
                          <CardContent className="space-y-3 pt-4">
                            {employee.approvals.length === 0 ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">当前没有需要你审批的事项。</div> : employee.approvals.map((item) => (
                              <div key={item.id} className="flex flex-col gap-4 rounded-2xl border border-slate-200 p-4 lg:flex-row lg:items-center">
                                <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600"><AlertTriangle className="size-4" /></div>
                                <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><div className="text-sm font-semibold">{item.title}</div><Badge>{item.id.slice(0, 12)}</Badge></div><p className="mt-1 text-xs text-slate-500">{item.message}</p><p className="mt-1 text-[11px] leading-5 text-slate-400">{approvalSummary(item.payload)}</p></div>
                                <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => void post(`/api/tasks/${item.taskId}/reject`, { approvalId: item.id })}><X className="size-3.5" />拒绝</Button><Button size="sm" onClick={() => void post(`/api/tasks/${item.taskId}/approve`, { approvalId: item.id })}><Check className="size-3.5" />批准并恢复</Button></div>
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      </div>
                    )}
                    {tab === "work" && (
                      <Card className="mt-5">
                        <CardHeader>
                          <div><CardTitle>工作</CardTitle><CardDescription>这个员工处理过的全部业务任务。</CardDescription></div>
                          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
                            {([["all", "全部"], ["active", "进行中"], ["waiting", "等待中"], ["done", "已完成"], ["failed", "失败"]] as [typeof workFilter, string][]).map(([id, label]) => (
                              <button key={id} onClick={() => setWorkFilter(id)} className={cn("rounded-lg px-3 py-1.5 text-xs font-medium transition", workFilter === id ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900")}>{label}</button>
                            ))}
                          </div>
                        </CardHeader>
                        <CardContent className="overflow-x-auto pt-4">
                          <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left">
                            <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400"><th className="border-b border-slate-100 px-3 py-3 font-medium">订单</th><th className="border-b border-slate-100 px-3 py-3 font-medium">供应商</th><th className="border-b border-slate-100 px-3 py-3 font-medium">物料</th><th className="border-b border-slate-100 px-3 py-3 font-medium">状态</th><th className="border-b border-slate-100 px-3 py-3 font-medium">承诺交期</th><th className="border-b border-slate-100 px-3 py-3 font-medium">下一步</th></tr></thead>
                            <tbody>
                              {filteredTasks.map((row) => (
                                <tr key={row.id} className="cursor-pointer text-sm hover:bg-slate-50">
                                  <td className="border-b border-slate-100 px-3 py-3.5 font-medium text-slate-900">{row.businessObjectId}</td>
                                  <td className="border-b border-slate-100 px-3 py-3.5 text-slate-600">{row.supplier}</td>
                                  <td className="border-b border-slate-100 px-3 py-3.5 text-slate-600">{row.item}</td>
                                  <td className="border-b border-slate-100 px-3 py-3.5"><Badge tone={toneForStatus(row.status)}>{row.statusZh}</Badge></td>
                                  <td className="border-b border-slate-100 px-3 py-3.5 text-slate-600">{row.promise}</td>
                                  <td className="border-b border-slate-100 px-3 py-3.5 text-slate-500">{row.next}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </CardContent>
                      </Card>
                    )}
                    {tab === "capability" && (
                      <div className="mt-5 space-y-5">
                        {(employee.capabilities?.length ?? 0) > 0 && (
                          <Card>
                            <CardHeader>
                              <div><CardTitle>能力模块</CardTitle><CardDescription>一个岗位由多个业务模块组成，而非拆成多个平级小员工。</CardDescription></div>
                            </CardHeader>
                            <CardContent className="grid gap-4 pt-4 md:grid-cols-2 xl:grid-cols-3">
                              {employee.capabilities.map((cap, i) => (
                                <div key={cap.id} className="rounded-2xl border border-slate-200 p-4">
                                  <div className="flex items-center justify-between gap-3">
                                    <div className="flex size-9 items-center justify-center rounded-xl bg-slate-950 text-[11px] font-semibold tracking-tight text-white">{String(i + 1).padStart(2, "0")}</div>
                                    <Badge tone="blue">{cap.workflows?.length ?? 0} 流程</Badge>
                                  </div>
                                  <div className="mt-4 text-sm font-semibold">{cap.name}</div>
                                  <p className="mt-2 text-xs leading-5 text-slate-500">{cap.description}</p>
                                  {cap.skills && cap.skills.length > 0 && (
                                    <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                                      {cap.skills.map((s) => <Badge key={s} tone="violet">{s}</Badge>)}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </CardContent>
                          </Card>
                        )}
                        <Card>
                          <CardHeader>
                            <div><CardTitle>业务流程能力</CardTitle><CardDescription>这个员工能独立处理哪些业务场景。</CardDescription></div>
                            <Button variant="outline" onClick={openWorkflowEditor}><Wrench className="size-4" />高级编排</Button>
                          </CardHeader>
                          <CardContent className="space-y-3 pt-4">
                            {employee.workflows.map((flow) => (
                              <div key={flow.id} className="rounded-2xl border border-slate-200 p-4">
                                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                  <div className="flex items-start gap-3">
                                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-slate-100"><Workflow className="size-4 text-slate-700" /></div>
                                    <div className="min-w-0"><div className="text-sm font-semibold">{flow.name}</div><div className="mt-1 text-xs text-slate-500">{flow.description}</div><div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400"><span className="flex items-center gap-1"><Zap className="size-3" />触发：{flow.trigger}</span><span>·</span><span>{flow.runs} 次运行 · 成功率 {flow.success}</span></div></div>
                                  </div>
                                  <Button variant="ghost" size="sm" onClick={() => setExpandedCap(expandedCap === flow.id ? null : flow.id)}>查看执行策略 <ChevronDown className={cn("size-3.5 transition", expandedCap === flow.id && "rotate-180")} /></Button>
                                </div>
                                {expandedCap === flow.id && (
                                  <div className="mt-4 grid gap-3 rounded-xl bg-slate-50 p-4 md:grid-cols-2">
                                    <div><div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">执行策略</div><p className="mt-1 text-xs leading-5 text-slate-600">{flow.description}</p></div>
                                    <div><div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">涉及权限</div><div className="mt-1 space-y-1">{employee.approvalRules.length ? employee.approvalRules.map((r) => <div key={r.id} className="flex items-center gap-1.5 text-xs text-slate-600"><ShieldCheck className="size-3 text-amber-600" />{r.name}</div>) : <div className="text-xs text-slate-400">无需人工审批</div>}</div></div>
                                  </div>
                                )}
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader>
                            <div><CardTitle>它会什么（技能）</CardTitle><CardDescription>沉淀为可复用的专业能力。</CardDescription></div>
                            <Button variant="outline" onClick={() => setShowCapPicker(true)}><Plus className="size-4" />添加能力</Button>
                          </CardHeader>
                          <CardContent className="grid gap-4 pt-4 md:grid-cols-2 xl:grid-cols-3">
                            {employee.skills.map((skill) => (
                              <div key={skill.id} className="rounded-2xl border border-slate-200 p-4">
                                <div className="flex items-start justify-between gap-4"><div className="flex size-9 items-center justify-center rounded-xl bg-slate-100"><WandSparkles className="size-4" /></div><Badge tone="blue">{skill.id}</Badge></div>
                                <div className="mt-4 text-sm font-semibold">{skill.name}</div><p className="mt-2 text-xs leading-5 text-slate-500">{skill.description}</p>
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      </div>
                    )}
                    {tab === "permission" && (
                      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_360px]">
                        <Card>
                          <CardHeader><div><CardTitle>权限边界</CardTitle><CardDescription>确定性权限规则不写进提示词；运行前由运行时强制检查。</CardDescription></div></CardHeader>
                          <CardContent className="space-y-2 pt-4">
                            {employee.permissions.map((p) => (
                              <div key={p.action + p.resource} className="flex items-center gap-4 rounded-xl border border-slate-200 p-4">
                                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100"><KeyRound className="size-3.5" /></div>
                                <div className="flex-1 text-sm text-slate-700">{p.resource}.{p.action}</div>
                                <Badge tone={p.effect === "deny" ? "red" : "green"}>{p.effect === "deny" ? "禁止" : "允许"}</Badge>
                              </div>
                            ))}
                            {employee.approvalRules.map((r) => (
                              <div key={r.id} className="flex items-center gap-4 rounded-xl border border-slate-200 p-4">
                                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100"><ShieldCheck className="size-3.5" /></div>
                                <div className="flex-1 text-sm text-slate-700">{r.name}</div><Badge tone="amber">需审批</Badge>
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader><div><CardTitle>授权概要</CardTitle><CardDescription>当前员工的最大可行动边界。</CardDescription></div></CardHeader>
                          <CardContent className="space-y-3 pt-4 text-xs">
                            <div className="rounded-xl bg-emerald-50 p-4 text-emerald-800"><div className="font-semibold">自动允许</div><div className="mt-1 leading-5 text-emerald-700">{employee.permissions.filter((p) => p.effect === "allow").map((p) => `${p.resource}.${p.action}`).join("、")}</div></div>
                            <div className="rounded-xl bg-amber-50 p-4 text-amber-800"><div className="font-semibold">需要审批</div><div className="mt-1 leading-5 text-amber-700">{employee.approvalRules.map((r) => r.name).join("、")}</div></div>
                            <div className="rounded-xl bg-red-50 p-4 text-red-800"><div className="font-semibold">禁止</div><div className="mt-1 leading-5 text-red-700">{employee.permissions.filter((p) => p.effect === "deny").map((p) => `${p.resource}.${p.action}`).join("、") || "无"}</div></div>
                          </CardContent>
                        </Card>
                      </div>
                    )}
                    {tab === "context" && (
                      <div className="mt-5 grid gap-5 xl:grid-cols-[360px_1fr]">
                        <Card>
                          <CardHeader><div><CardTitle>可见范围</CardTitle><CardDescription>被授权读取的企业事实类型。</CardDescription></div></CardHeader>
                          <CardContent className="space-y-2 pt-4">
                            {employee.contextScope.map((s) => <div key={s} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3"><div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100"><BrainCircuit className="size-3.5" /></div><div className="text-sm text-slate-700">{s}</div><Badge tone="green">可读</Badge></div>)}
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader><div><CardTitle>知识实体</CardTitle><CardDescription>当前上下文图中的相关实体（按权限过滤）。</CardDescription></div></CardHeader>
                          <CardContent className="space-y-2 pt-4">
                            {employee.context.entities.map((e) => (
                              <div key={e.id} className="flex items-center gap-3 rounded-xl border border-slate-200 p-3"><Badge tone="blue">{e.type}</Badge><div className="font-medium text-sm text-slate-800">{e.id}</div><div className="flex-1 truncate text-xs text-slate-400">{JSON.stringify(e.attributes).slice(0, 90)}</div></div>
                            ))}
                          </CardContent>
                        </Card>
                      </div>
                    )}
                    {tab === "performance" && (
                      <div className="mt-5 grid gap-5 xl:grid-cols-3">
                        <Card><CardHeader><div><CardTitle>业务 KPI</CardTitle><CardDescription>评价“员工做得好不好”。</CardDescription></div></CardHeader><CardContent className="space-y-5 pt-5">
                          {[["任务成功率", employee.kpi.successRate, pct(employee.kpi.successRate)], ["按时交付率", employee.kpi.onTimeRate, pct(employee.kpi.onTimeRate)], ["人工介入率", employee.kpi.interventionRate, pct(employee.kpi.interventionRate)]].map(([l, v, s]) => <div key={String(l)}><div className="mb-2 flex justify-between text-xs"><span className="text-slate-500">{l}</span><span className="font-medium">{s}</span></div><Progress value={Number(v) * 100} /></div>)}
                        </CardContent></Card>
                        <Card><CardHeader><div><CardTitle>目标与指标</CardTitle><CardDescription>被委派的岗位目标。</CardDescription></div></CardHeader><CardContent className="space-y-4 pt-5">
                          {employee.goals.map((g) => (<div key={g.id} className="rounded-xl border border-slate-200 p-4"><div className="text-sm font-semibold">{g.title}</div><p className="mt-1 text-xs text-slate-500">{g.description}</p><div className="mt-2 flex flex-wrap gap-1.5">{g.kpis.map((k) => <Badge key={k.id} tone="violet">{k.name}{k.target ? ` ≥ ${k.target}${k.unit}` : ""}</Badge>)}</div></div>))}
                        </CardContent></Card>
                        <Card><CardHeader><div><CardTitle>上线等级</CardTitle><CardDescription>从影子模式逐步把权限交给 AI。</CardDescription></div></CardHeader><CardContent className="pt-5">
                          <div className="space-y-4">
                            {[["影子模式", "已通过", true], ["受监督模式", mode === "supervised" ? "当前" : mode === "autonomous" ? "已通过" : "待启用", mode !== "shadow"], ["自主模式", mode === "autonomous" ? "当前" : "待解锁", mode === "autonomous"]].map(([name, status, done], i) => (
                              <div key={String(name)} className="flex items-center gap-3"><div className={cn("flex size-8 items-center justify-center rounded-full", done ? "bg-slate-950 text-white" : "bg-slate-100 text-slate-400")}>{done ? <Check className="size-3.5" /> : i + 1}</div><div className="flex-1"><div className="text-sm font-medium">{name}</div><div className="text-xs text-slate-400">{status}</div></div></div>
                            ))}
                          </div>
                        </CardContent></Card>
                      </div>
                    )}
                    {tab === "settings" && (
                      <div className="mt-5 grid gap-5 xl:grid-cols-2">
                        <Card><CardHeader><div><CardTitle>部署模式</CardTitle><CardDescription>决定 AI 员工的行动边界。</CardDescription></div></CardHeader><CardContent className="pt-4">
                          <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 p-1">
                            {([["shadow", "影子"], ["supervised", "受监督"], ["autonomous", "自主"]] as [DeployMode, string][]).map(([id, label]) => (
                              <button key={id} onClick={() => void setDeployMode(id)} className={cn("flex-1 rounded-lg px-3 py-2 text-xs font-medium transition", mode === id ? "bg-white text-slate-950 shadow-sm" : "text-slate-500 hover:text-slate-900")}>{label}</button>
                            ))}
                          </div>
                        </CardContent></Card>
                        <Card><CardHeader><div><CardTitle>基本信息</CardTitle><CardDescription>岗位与预算配置。</CardDescription></div></CardHeader><CardContent className="space-y-3 pt-4 text-sm">
                          <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">版本</span><span className="font-medium">{employee.version}</span></div>
                          <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">部门</span><span className="font-medium">{employee.deptName}</span></div>
                          <div className="flex justify-between border-b border-slate-100 pb-2"><span className="text-slate-500">直属经理</span><span className="font-medium">{employee.managerName}</span></div>
                          <div className="flex justify-between"><span className="text-slate-500">月度预算</span><span className="font-medium">{employee.budget?.monthlyCap ?? "—"} {employee.budget?.currency ?? ""}</span></div>
                        </CardContent></Card>
                        <Card className="xl:col-span-2"><CardHeader><div><CardTitle>高级配置</CardTitle><CardDescription>底层技术抽象（工作器 / 工作流 / 技能 / 工具）在这里管理。</CardDescription></div><Button onClick={openWorkflowEditor}><Wrench className="size-4" />进入开发者视图</Button></CardHeader></Card>
                      </div>
                    )}
                  </>
                )}

                {viewMode === "developer" && (
                  <div className="mt-5">
                    {devTab === "editor" && (
                      <>
                        {/* Editor 顶部：员工 / 工作流选择器 / 运行模式 / 发布 */}
                        <div className="rounded-2xl border border-slate-200 bg-white p-3">
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex items-center gap-2.5">
                              <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white"><Blocks className="size-4" /></div>
                              <div>
                                <div className="text-sm font-semibold text-slate-900">{employee?.name ?? "采购执行员工"} <span className="font-normal text-slate-400">/ 编排器</span></div>
                                <div className="flex items-center gap-1.5 text-[10px] text-slate-400"><span>一个员工 · 内部专业能力节点 · 正在编辑：{editWorkflow.name}</span>{(editWorkflow.draftRevision ?? 0) > (editWorkflow.publishedRevision ?? 0) && <Badge tone="amber">未发布</Badge>}</div>
                              </div>
                              <select value={editWf} onChange={(e) => { setEditWf(e.target.value); setSelNodeId(null); setSelEdgeId(null); }} className="ml-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 outline-none focus:border-slate-400">
                                {editorWorkflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                              </select>
                            </div>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Button size="sm" variant="outline" disabled={editorRunBusy !== null || !editWorkflow.id} onClick={() => void runEditorTest("simulate")}><Play className="size-3.5" />{editorRunBusy === "simulate" ? "模拟中…" : "模拟运行"}</Button>
                              <Button size="sm" variant="outline" disabled={editorRunBusy !== null || !editWorkflow.id} onClick={() => void runEditorTest("shadow")}><Eye className="size-3.5" />{editorRunBusy === "shadow" ? "运行中…" : "影子运行"}</Button>
                              <Button size="sm" variant="outline" disabled={editorRunBusy !== null || !editWorkflow.id} onClick={() => void runEditorTest("supervised")}><ShieldCheck className="size-3.5" />{editorRunBusy === "supervised" ? "挂起中…" : "审批运行"}</Button>
                              <Button size="sm" variant="outline" disabled={editorRunBusy !== null || !editWorkflow.id} onClick={() => void runEditorTest("autonomous")}><Zap className="size-3.5" />{editorRunBusy === "autonomous" ? "启用中…" : "自动运行"}</Button>
                              <Button size="sm" disabled={editorRunBusy !== null || editorLoading} onClick={() => void publishEditor()}><Rocket className="size-3.5" />{editorRunBusy === "publish" ? "发布中…" : "发布"}</Button>
                            </div>
                          </div>
                          {editorError && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-[11px] text-red-700">{editorError}</div>}
                          {blueprintUpgradePreview?.status === "upgrade_available" && (
                            <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-3 text-[11px] text-amber-950" role="status">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="flex items-center gap-1.5 font-semibold"><History className="size-3.5" />V1 工作流蓝图可导入</span>
                                    <Badge tone="amber">{blueprintUpgradePreview.packVersion}</Badge>
                                    <span className="font-mono text-[9px] text-amber-700">{blueprintUpgradePreview.packId}</span>
                                  </div>
                                  <p className="mt-1 leading-5 text-amber-800">{blueprintUpgradePreview.reason} 导入只更新未发布草稿，不会启动流程、发送邮件、写 ERP 或改变正式 PO。</p>
                                </div>
                                {!blueprintUpgradeConfirming ? (
                                  <Button size="sm" variant="outline" onClick={() => setBlueprintUpgradeConfirming(true)} disabled={blueprintUpgradeBusy}>查看差异并导入</Button>
                                ) : null}
                              </div>
                              <div className="mt-2 grid gap-2 lg:grid-cols-3">
                                {blueprintUpgradePreview.workflows.map((workflow) => (
                                  <div key={workflow.workflowId} className={cn("rounded-lg border px-2.5 py-2", workflow.status === "replace" ? "border-amber-200 bg-white/80" : "border-emerald-200 bg-emerald-50/70")}>
                                    <div className="flex items-center justify-between gap-2"><span className="truncate font-semibold text-slate-800">{workflow.workflowName}</span><Badge tone={workflow.status === "replace" ? "amber" : "green"}>{workflow.status === "replace" ? "将替换" : "已一致"}</Badge></div>
                                    <div className="mt-1 text-[10px] text-slate-500">r{workflow.currentRevision} · 节点 {workflow.currentNodeCount} → {workflow.blueprintNodeCount} · 连线 {workflow.currentEdgeCount} → {workflow.blueprintEdgeCount}</div>
                                    {workflow.status === "replace" && <div className="mt-1 text-[10px] text-amber-700">节点 +{workflow.addedNodeIds.length} / −{workflow.removedNodeIds.length} / 改 {workflow.changedNodeIds.length} · 连线 +{workflow.addedEdgeIds.length} / −{workflow.removedEdgeIds.length} / 改 {workflow.changedEdgeIds.length}</div>}
                                  </div>
                                ))}
                              </div>
                              {blueprintUpgradeConfirming && (
                                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-amber-200 pt-3">
                                  <div className="max-w-2xl leading-5 text-amber-800"><span className="font-semibold">确认范围：</span>系统会在一个事务中备份并替换以上三条草稿；原备份和操作者会写入审计表。导入后仍需另行检查并发布。</div>
                                  <div className="flex items-center gap-2">
                                    <Button size="sm" variant="outline" onClick={() => setBlueprintUpgradeConfirming(false)} disabled={blueprintUpgradeBusy}>取消</Button>
                                    <Button size="sm" onClick={() => void importV1Blueprint()} disabled={blueprintUpgradeBusy}>{blueprintUpgradeBusy ? "正在备份并导入…" : "确认备份并导入"}</Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          {editWf === "invoice-match" && (
                            <div className={cn("mt-2 rounded-xl border px-3 py-2.5 text-[11px]", invoiceUpgradePreview?.status === "eligible" ? "border-amber-200 bg-amber-50/70 text-amber-900" : "border-slate-200 bg-slate-50 text-slate-600")}>
                              {invoiceUpgradeLoading ? <span>正在检查旧版三单匹配升级…</span> : !invoiceUpgradePreview ? <span>暂时无法读取三单匹配升级状态。</span> : <>
                                <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold">行级三单匹配</span><Badge tone={invoiceUpgradePreview.status === "eligible" ? "amber" : invoiceUpgradePreview.status === "already_current" ? "green" : "neutral"}>{invoiceUpgradePreview.status === "eligible" ? "可升级" : invoiceUpgradePreview.status === "already_current" ? "已是当前版本" : "不适用"}</Badge></div>
                                <div className="mt-1 leading-5">{invoiceUpgradePreview.reason}</div>
                                {invoiceUpgradePreview.status === "eligible" && <>
                                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-amber-800"><span>替换节点 {invoiceUpgradePreview.changedNodeIds.length}</span><span>新增节点 {invoiceUpgradePreview.addedNodeIds.length}</span><span>新增分支 {invoiceUpgradePreview.addedEdges.length}</span><span>移除连线 {invoiceUpgradePreview.removedEdgeIds.length}</span></div>
                                  {invoiceUpgradePreview.addedEdges.length > 0 && <div className="mt-1 truncate text-[10px] text-amber-700">影响路径：{invoiceUpgradePreview.addedEdges.slice(0, 4).map((edge) => `${edge.from} → ${edge.to}${edge.label ? `（${edge.label}）` : ""}`).join(" · ")}</div>}
                                  {!invoiceUpgradeConfirming ? <Button size="sm" className="mt-2" onClick={() => setInvoiceUpgradeConfirming(true)} disabled={invoiceUpgradeBusy}>查看影响后升级</Button> : <div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-[10px] font-semibold">确认将当前草稿升级为行级匹配？</span><Button size="sm" onClick={() => void upgradeInvoiceMatch()} disabled={invoiceUpgradeBusy}>{invoiceUpgradeBusy ? "升级中…" : "确认升级"}</Button><Button size="sm" variant="outline" onClick={() => setInvoiceUpgradeConfirming(false)} disabled={invoiceUpgradeBusy}>取消</Button></div>}
                                </>}
                              </>}
                            </div>
                          )}
                          {editorRuntime && (
                            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 text-[10px] text-slate-500">
                              <span className="flex items-center gap-1"><Activity className={cn("size-3", editorRuntime.temporal.workerObserved ? "text-emerald-600" : editorRuntime.temporal.connected ? "text-amber-600" : "text-red-600")} />Temporal {editorRuntime.temporal.workerObserved ? `工作器在线 (${editorRuntime.temporal.pollerCount})` : editorRuntime.temporal.connected ? "服务在线 / 工作器未观测" : "未连接"}</span>
                              <span className="flex items-center gap-1" title={agentRuntimeDiagnosticZh(editorRuntime.agentRuntime.error ?? editorRuntime.agentRuntime.note)}><BrainCircuit className={cn("size-3", editorRuntime.agentRuntime.readiness === "ready" ? "text-emerald-600" : editorRuntime.agentRuntime.readiness === "unconfigured" || editorRuntime.agentRuntime.readiness === "not_observed" ? "text-amber-600" : "text-red-600")} />AI 运行时 <Badge tone={editorRuntime.agentRuntime.readiness === "ready" ? "green" : editorRuntime.agentRuntime.readiness === "unconfigured" || editorRuntime.agentRuntime.readiness === "not_observed" ? "amber" : "red"}>{agentRuntimeNameZh[editorRuntime.agentRuntime.runtime]} · {agentReadinessZh[editorRuntime.agentRuntime.readiness]}</Badge></span>
                              <span className="font-mono text-[10px] text-slate-400">{editorRuntime.agentRuntime.provider} / {editorRuntime.agentRuntime.model} · {agentIsolationZh[editorRuntime.agentRuntime.isolation]} · {editorRuntime.agentRuntime.observed ? "工作器已观测" : "工作器未观测"}</span>
                              {editorRuntime.agentRuntime.error && <span className="max-w-[260px] truncate text-red-600" title={agentRuntimeDiagnosticZh(editorRuntime.agentRuntime.error)}>{agentRuntimeDiagnosticZh(editorRuntime.agentRuntime.error)}</span>}
                              <span className="flex items-center gap-1"><Network className="size-3 text-blue-600" />节点工厂 · 变量池 · 图校验</span>
                              <span className="flex items-center gap-1"><Plug className="size-3 text-violet-600" />连接器 {editorRuntime.connectors.healthy}/{editorRuntime.connectors.installed} 个已通过外部验证</span>
                              <span className="flex items-center gap-1"><KeyRound className={cn("size-3", editorRuntime.credentials.encryptedPersistence ? "text-emerald-600" : "text-amber-600")} />凭据{editorRuntime.credentials.encryptedPersistence ? "加密持久化" : "待配置加密密钥"}</span>
                              <span className="ml-auto font-mono text-slate-400">{editorRuntime.temporal.taskQueue}</span>
                            </div>
                          )}
                        </div>

                        {/* Editor 三栏：组件库 | 画布 | 节点设置 */}
                        <div className="mt-3 grid items-start gap-3 xl:grid-cols-[230px_minmax(0,1fr)_290px]">
                          {/* 组件库 */}
                          <div className="self-start rounded-2xl border border-slate-200 bg-white p-3 xl:sticky xl:top-20">
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-semibold text-slate-700">组件库</div>
                              <Badge tone="violet">{editorLibrary.reduce((s, g) => s + g.items.length, 0)} 个节点</Badge>
                            </div>
                            <p className="mt-0.5 text-[10px] text-slate-400">工作器 / 技能 / 工具均可拖入画布</p>
                            <div className="mt-3 max-h-[clamp(620px,70vh,840px)] space-y-3 overflow-y-auto pr-1">
                              {editorLibrary.map((g) => (
                                <div key={g.group}>
                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{g.group}</div>
                                  <div className="mt-1.5 space-y-1">
                                    {g.items.map((it) => (
                                      <button key={it.id} draggable onDragStart={(event) => event.dataTransfer.setData("text/editor-asset", it.id)} disabled={editorSaving} onClick={() => void addEditorNode(it.id)} className="flex w-full items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-1.5 text-left transition hover:border-blue-200 hover:bg-blue-50/40 disabled:opacity-50">
                                        <span className={cn("size-1.5 shrink-0 rounded-full", NODE_KIND_STYLE[it.kind].chip.split(" ")[0])} />
                                        <span className="truncate text-xs font-medium text-slate-700">{it.label}</span>
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          {/* 画布 */}
                          <div className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <Workflow className="size-4 text-slate-400" />
                                <div className="text-sm font-semibold text-slate-800">{editWorkflow.name}</div>
                                <Badge tone="violet">{editWorkflow.id}</Badge>
                              </div>
                              <div className="flex flex-wrap items-center justify-end gap-2">
                                <div className="hidden max-w-[320px] truncate text-[11px] text-slate-400 2xl:block">{editWorkflow.desc}</div>
                                <select
                                  aria-label="选择画布运行轨迹"
                                  value={editorCanvasRunId ?? ""}
                                  disabled={editorWorkflowRuns.length === 0}
                                  onChange={(event) => {
                                    const runId = event.target.value || null;
                                    setEditorCanvasRunId(runId);
                                    if (runId) void loadEditorRunDetail(runId);
                                  }}
                                  className="h-8 max-w-[260px] rounded-lg border border-slate-200 bg-white px-2 text-[10px] font-medium text-slate-600 outline-none focus:border-blue-400 disabled:bg-slate-50 disabled:text-slate-400"
                                >
                                  {editorWorkflowRuns.length === 0 ? <option value="">暂无持久化运行</option> : editorWorkflowRuns.map((run) => <option key={run.id} value={run.id}>{formatDateTime(run.createdAt)} · {editorRunStatusZh(run.status)} · {editorRunModeZh[run.mode]}</option>)}
                                </select>
                                {editorCanvasRunId && !editorCanvasRunDetail ? <Badge tone="neutral">读取运行…</Badge> : editorCanvasRunDetail ? <Badge tone={toneForStatus(editorCanvasRunDetail.status)}>{editorRunStatusZh(editorCanvasRunDetail.status)}</Badge> : null}
                              </div>
                            </div>
                            <div className="mt-4">
                              <WorkflowCanvas
                                workflowId={editWorkflow.id}
                                revision={editWorkflow.draftRevision ?? 0}
                                nodes={editWorkflow.nodes}
                                edges={editWorkflow.edges}
                                selectedNodeId={selNodeId}
                                selectedEdgeId={selEdgeId}
                                saving={editorSaving}
                                loading={editorLoading && editorWorkflows.length === 0}
                                runtimeOverlay={editorCanvasRuntimeOverlay}
                                onSelectNode={setSelNodeId}
                                onSelectEdge={setSelEdgeId}
                                onAddAsset={addEditorNode}
                                onCommit={commitEditorGraph}
                              />
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2 text-[10px] text-slate-400">
                              <span>图例：</span>
                              {(Object.keys(NODE_KIND_STYLE) as EditorNodeKind[]).map((k) => (
                                <span key={k} className="flex items-center gap-1"><span className={cn("size-1.5 rounded-full", NODE_KIND_STYLE[k].chip.split(" ")[0])} />{NODE_KIND_STYLE[k].label}</span>
                              ))}
                              {editorCanvasRuntimeOverlay && <><span className="ml-2 h-3 w-px bg-slate-200" /><span className="flex items-center gap-1 text-blue-600"><span className="size-1.5 animate-pulse rounded-full bg-blue-500" />执行中</span><span className="flex items-center gap-1 text-amber-600"><span className="size-1.5 rounded-full bg-amber-500" />等待/拦截</span><span className="flex items-center gap-1 text-emerald-600"><span className="size-1.5 rounded-full bg-emerald-500" />完成</span><span className="flex items-center gap-1 text-red-600"><span className="size-1.5 rounded-full bg-red-500" />失败</span></>}
                              <span className="ml-auto">{editorSaving ? "正在保存…" : "拖拽节点 · 端口连线 · Shift 框选 · Delete 删除 · ⌘C/⌘V 复制粘贴"}</span>
                            </div>
                          </div>

                          {/* 节点设置 */}
                          <div className="max-h-[clamp(720px,76vh,960px)] self-start overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 xl:sticky xl:top-20">
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-semibold text-slate-700">{selEdge ? "连线设置" : "节点设置"}</div>
                              {selNode && <Badge tone={selNode.kind === "approval" ? "red" : selNode.kind === "router" ? "blue" : selNode.kind === "ai" ? "violet" : "neutral"}>{NODE_KIND_STYLE[selNode.kind].label}</Badge>}
                              {selEdge && <Badge tone="blue">连线</Badge>}
                            </div>
                            {selNode && nodeDraft ? (
                              <div className="mt-3 space-y-3">
                                {selNodeDescriptor && (
                                  <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-2.5">
                                    <div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] font-semibold text-blue-800">{selNodeDescriptor.type}@{selNodeDescriptor.version}</span><Badge tone={selNodeDescriptor.runtime === "connector" ? "violet" : "blue"}>{selNodeDescriptor.runtime}</Badge></div>
                                    <div className="mt-1 truncate font-mono text-[9px] text-blue-600">{selNodeDescriptor.executor}</div>
                                  </div>
                                )}
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">名称</div>
                                  <input value={nodeDraft.label} onChange={(event) => setNodeDraft({ ...nodeDraft, label: event.target.value })} className="mt-1 h-8 w-full rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-slate-400" />
                                </div>
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">说明</div>
                                  <textarea value={nodeDraft.detail} onChange={(event) => setNodeDraft({ ...nodeDraft, detail: event.target.value })} rows={2} className="mt-1 w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] leading-4 outline-none focus:border-slate-400" />
                                </div>
                                {selNodeDescriptor ? (
                                  <div className="grid grid-cols-2 gap-2">
                                    <div><div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">输入结构</div><div className="mt-1 space-y-1">{selNodeDescriptor.inputs.length ? selNodeDescriptor.inputs.map((port) => <div key={port.id} className="rounded-lg bg-slate-50 px-2 py-1 text-[10px]"><div className="font-mono text-slate-700">{port.id}{port.required ? " *" : ""}</div><div className="text-[9px] text-slate-400">{port.label} · {port.dataType}</div></div>) : <div className="text-[10px] text-slate-400">无输入</div>}</div></div>
                                    <div><div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">输出结构</div><div className="mt-1 space-y-1">{selNodeDescriptor.outputs.length ? selNodeDescriptor.outputs.map((port) => <div key={port.id} className="rounded-lg bg-slate-50 px-2 py-1 text-[10px]"><div className="font-mono text-slate-700">{port.id}</div><div className="text-[9px] text-slate-400">{port.label} · {port.dataType}</div></div>) : <div className="text-[10px] text-slate-400">无输出</div>}</div></div>
                                  </div>
                                ) : (
                                  <div className="grid grid-cols-2 gap-2">
                                    <div><div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">输入</div><textarea value={nodeDraft.inputs} onChange={(event) => setNodeDraft({ ...nodeDraft, inputs: event.target.value })} placeholder="逗号分隔" rows={2} className="mt-1 w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 text-[10px] outline-none focus:border-slate-400" /></div>
                                    <div><div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">输出</div><textarea value={nodeDraft.outputs} onChange={(event) => setNodeDraft({ ...nodeDraft, outputs: event.target.value })} placeholder="逗号分隔" rows={2} className="mt-1 w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 text-[10px] outline-none focus:border-slate-400" /></div>
                                  </div>
                                )}
                                {(selNodeDescriptor?.parameters.length ?? 0) > 0 && (
                                  <div>
                                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">参数</div>
                                    <div className="mt-1.5 space-y-2">{selNodeDescriptor!.parameters.map((parameter) => {
                                      const value = nodeParameterDraft[parameter.id] ?? "";
                                      if (parameter.control === "boolean") return <label key={parameter.id} className="flex items-center justify-between rounded-lg border border-slate-200 px-2 py-1.5 text-[10px] text-slate-600"><span>{parameter.label}</span><input type="checkbox" checked={Boolean(value)} onChange={(event) => setNodeParameterDraft((previous) => ({ ...previous, [parameter.id]: event.target.checked }))} /></label>;
                                      if (parameter.control === "select") return <label key={parameter.id} className="block"><span className="text-[10px] text-slate-500">{parameter.label}{parameter.required ? " *" : ""}</span><select value={String(value)} onChange={(event) => setNodeParameterDraft((previous) => ({ ...previous, [parameter.id]: event.target.value }))} className="mt-1 h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[10px] outline-none">{parameter.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>;
                                      const multiline = ["textarea", "json", "expression"].includes(parameter.control);
                                      return <label key={parameter.id} className="block"><span className="text-[10px] text-slate-500">{parameter.label}{parameter.required ? " *" : ""}</span>{multiline ? <textarea value={String(value)} onChange={(event) => setNodeParameterDraft((previous) => ({ ...previous, [parameter.id]: event.target.value }))} rows={2} className="mt-1 w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-[10px] outline-none" /> : <input type={parameter.control === "number" ? "number" : parameter.secret ? "password" : "text"} value={String(value)} onChange={(event) => setNodeParameterDraft((previous) => ({ ...previous, [parameter.id]: parameter.control === "number" ? Number(event.target.value) : event.target.value }))} className="mt-1 h-8 w-full rounded-lg border border-slate-200 px-2 text-[10px] outline-none" />}{parameter.description && <span className="mt-0.5 block text-[9px] text-slate-400">{parameter.description}</span>}</label>;
                                    })}</div>
                                  </div>
                                )}
                                {selNode.rules && (
                                  <div>
                                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">规则（阈值分级，与规则页共用同一事实源）</div>
                                    <div className="mt-1 space-y-1">{selNode.rules.map((r, i) => (
                                      <div key={i} className="flex items-center justify-between rounded-lg bg-slate-50 px-2 py-1.5 text-[11px]">
                                        <span className="text-slate-600">{r.cond}</span>
                                        <Badge tone={r.level === "auto" ? "green" : r.level === "buyer" ? "blue" : r.level === "finance" ? "violet" : "red"}>{r.action}</Badge>
                                      </div>
                                    ))}</div>
                                  </div>
                                )}
                                <div className="grid grid-cols-2 gap-2">
                                  <div>
                                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">超时（秒）</div>
                                    <input value={nodeDraft.timeoutSeconds} type="number" min={0} onChange={(event) => setNodeDraft({ ...nodeDraft, timeoutSeconds: event.target.value })} className="mt-1 h-8 w-full rounded-lg border border-slate-200 px-2 text-[11px] text-slate-600 outline-none focus:border-slate-400" />
                                  </div>
                                  <div>
                                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">重试</div>
                                    <input value={nodeDraft.retries} type="number" min={0} onChange={(event) => setNodeDraft({ ...nodeDraft, retries: event.target.value })} className="mt-1 h-8 w-full rounded-lg border border-slate-200 px-2 text-[11px] text-slate-600 outline-none focus:border-slate-400" />
                                  </div>
                                </div>
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">权限</div>
                                  <select value={nodeDraft.permission} onChange={(event) => setNodeDraft({ ...nodeDraft, permission: event.target.value })} className="mt-1 h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[11px] text-slate-700 outline-none focus:border-slate-400"><option value="auto">自动执行</option><option value="buyer">采购员审批</option><option value="manager">采购经理审批</option><option value="finance">财务审批</option></select>
                                </div>
                                {(selNodeDescriptor?.credentials.length ?? 0) > 0 && (
                                  <div>
                                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">凭据</div>
                                    <select value={nodeDraft.credentialRef} onChange={(event) => setNodeDraft({ ...nodeDraft, credentialRef: event.target.value })} className="mt-1 h-8 w-full rounded-lg border border-slate-200 bg-white px-2 text-[10px] text-slate-700 outline-none"><option value="">使用环境连接</option>{selNodeDescriptor!.credentials.map((credential) => <option key={credential.type} value={`credential:${credential.type}:default`}>{credential.type}{credential.required ? " *" : ""}</option>)}</select>
                                    <div className="mt-1 text-[9px] text-slate-400">{selNodeDescriptor!.credentials.flatMap((credential) => credential.scopes ?? []).join(" · ")}</div>
                                  </div>
                                )}
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">失败策略</div>
                                  <input value={nodeDraft.failAction} onChange={(event) => setNodeDraft({ ...nodeDraft, failAction: event.target.value })} className="mt-1 h-8 w-full rounded-lg border border-slate-200 px-2 text-[11px] text-slate-600 outline-none focus:border-slate-400" />
                                </div>
                                <div>
                                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">副作用控制</div>
                                  <input value={nodeDraft.sideEffects} onChange={(event) => setNodeDraft({ ...nodeDraft, sideEffects: event.target.value })} placeholder="例如：写 ERP，发邮件" className="mt-1 h-8 w-full rounded-lg border border-amber-200 bg-amber-50/40 px-2 text-[11px] text-amber-800 outline-none focus:border-amber-400" />
                                </div>
                                <Button size="sm" className="w-full" disabled={editorSaving || !nodeDraft.label.trim()} onClick={() => void saveSelectedNode()}><Save className="size-3.5" />{editorSaving ? "保存中…" : "保存节点"}</Button>
                              </div>
                            ) : selEdge ? (
                              <div className="mt-3 space-y-3">
                                <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-3">
                                  <div className="flex items-center gap-2 text-[10px] font-semibold text-blue-800"><span className="font-mono">{selEdge.from}</span><ArrowRight className="size-3" /><span className="font-mono">{selEdge.to}</span></div>
                                  <div className="mt-1 text-[9px] text-blue-600">连线决定节点完成后进入哪个下一步</div>
                                </div>
                                <label className="block"><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">分支标签</span><input value={edgeDraft.label} onChange={(event) => setEdgeDraft({ ...edgeDraft, label: event.target.value })} placeholder="例如：差异超限" className="mt-1 h-8 w-full rounded-lg border border-slate-200 px-2 text-[11px] outline-none focus:border-blue-400" /></label>
                                <label className="block"><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">执行条件</span><textarea value={edgeDraft.condition} onChange={(event) => setEdgeDraft({ ...edgeDraft, condition: event.target.value })} placeholder="例如：variancePct > 3" rows={3} className="mt-1 w-full resize-none rounded-lg border border-slate-200 px-2 py-1.5 font-mono text-[10px] outline-none focus:border-blue-400" /></label>
                                <div className="grid grid-cols-2 gap-2">
                                  <label className="block"><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">输出端口</span><input value={edgeDraft.sourcePort} onChange={(event) => setEdgeDraft({ ...edgeDraft, sourcePort: event.target.value })} className="mt-1 h-8 w-full rounded-lg border border-slate-200 px-2 font-mono text-[10px] outline-none" /></label>
                                  <label className="block"><span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">输入端口</span><input value={edgeDraft.targetPort} onChange={(event) => setEdgeDraft({ ...edgeDraft, targetPort: event.target.value })} className="mt-1 h-8 w-full rounded-lg border border-slate-200 px-2 font-mono text-[10px] outline-none" /></label>
                                </div>
                                <Button size="sm" className="w-full" disabled={editorSaving} onClick={() => void saveSelectedEdge()}><Save className="size-3.5" />{editorSaving ? "保存中…" : "保存连线"}</Button>
                                <Button size="sm" variant="outline" className="w-full border-red-200 text-red-600 hover:bg-red-50" disabled={editorSaving} onClick={() => void deleteSelectedEdge()}><X className="size-3.5" />删除连线</Button>
                              </div>
                            ) : (
                              <div className="mt-3 rounded-xl border border-dashed border-slate-200 p-6 text-center text-xs text-slate-400">点击节点编辑配置，点击连线编辑条件；也可以从端口直接拖出新连线</div>
                            )}
                          </div>
                        </div>
                      </>
                    )}

                    {devTab === "runs" && (
                      <div className="space-y-4">
                        <Card>
                          <CardHeader><div><CardTitle>Temporal 运行记录</CardTitle><CardDescription>Temporal 负责可靠推进、等待与恢复；AI 运行时负责推理与工具选择。运行时就绪要求配置有效，且任务队列已观测到工作器轮询器。</CardDescription></div>{editorRuntime && <div className="flex items-center gap-2"><Badge tone={editorRuntime.agentRuntime.readiness === "ready" ? "green" : editorRuntime.agentRuntime.readiness === "unconfigured" || editorRuntime.agentRuntime.readiness === "not_observed" ? "amber" : "red"}>{agentRuntimeNameZh[editorRuntime.agentRuntime.runtime]} · {agentReadinessZh[editorRuntime.agentRuntime.readiness]}</Badge><Badge tone={editorRuntime.temporal.workerObserved ? "green" : editorRuntime.temporal.connected ? "amber" : "red"}>{editorRuntime.temporal.workerObserved ? "工作器在线" : editorRuntime.temporal.connected ? "工作器未观测" : "Temporal 离线"}</Badge></div>}</CardHeader>
                          <CardContent className="overflow-x-auto pt-4">
                            <table className="w-full min-w-[860px] border-separate border-spacing-0 text-left text-sm">
                              <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400"><th className="border-b border-slate-100 px-3 py-2 font-medium">时间</th><th className="border-b border-slate-100 px-3 py-2 font-medium">工作流 / 版本</th><th className="border-b border-slate-100 px-3 py-2 font-medium">模式</th><th className="border-b border-slate-100 px-3 py-2 font-medium">状态</th><th className="border-b border-slate-100 px-3 py-2 font-medium">节点</th><th className="border-b border-slate-100 px-3 py-2 font-medium">当前结果</th></tr></thead>
                              <tbody>{editorRuns.length === 0 ? <tr><td colSpan={6} className="border-b border-slate-100 px-3 py-8 text-center text-xs text-slate-400">尚无运行记录</td></tr> : editorRuns.map((run) => (
                                <tr key={run.id} onClick={() => void loadEditorRunDetail(run.id)} className={cn("cursor-pointer hover:bg-slate-50", editorRunDetail?.id === run.id && "bg-blue-50/50")}><td className="border-b border-slate-100 px-3 py-3 font-mono text-xs text-slate-500">{formatDateTime(run.createdAt)}</td><td className="border-b border-slate-100 px-3 py-3"><div className="text-slate-700">{run.workflowName}</div><div className="font-mono text-[10px] text-slate-400">{run.workflowVersion ?? "旧版"}</div></td><td className="border-b border-slate-100 px-3 py-3"><Badge tone={run.mode === "autonomous" ? "green" : run.mode === "supervised" ? "blue" : "neutral"}>{editorRunModeZh[run.mode]}</Badge></td><td className="border-b border-slate-100 px-3 py-3"><Badge tone={toneForStatus(run.status)}>{editorRunStatusZh(run.status)}</Badge></td><td className="border-b border-slate-100 px-3 py-3 text-xs text-slate-500">{run.nodeCount ?? 0}</td><td className="max-w-[360px] border-b border-slate-100 px-3 py-3 text-xs text-slate-500">{run.message}</td></tr>
                              ))}</tbody>
                            </table>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader>
                            <div><CardTitle>节点运行时间线</CardTitle><CardDescription>{editorRunDetail ? `${editorRunDetail.id} · ${editorRunDetail.temporalWorkflowId ?? "Temporal"}` : "选择上方一次运行查看持久化节点轨迹"}</CardDescription></div>
                            {editorRunDetail && <div className="flex flex-wrap gap-1.5">{editorRunDetail.status === "waiting_approval" && <><Button size="sm" onClick={() => void actOnEditorRun("approve")}><Check className="size-3.5" />批准并恢复</Button><Button size="sm" variant="outline" onClick={() => void actOnEditorRun("reject")}><X className="size-3.5" />驳回</Button></>}{editorRunDetail.status === "waiting_external" && <Button size="sm" onClick={() => void actOnEditorRun("event")}><Send className="size-3.5" />发送恢复事件</Button>}{["queued", "running", "waiting_approval", "waiting_external"].includes(editorRunDetail.status) && <Button size="sm" variant="outline" onClick={() => void actOnEditorRun("cancel")}>取消运行</Button>}</div>}
                          </CardHeader>
                          <CardContent className="pt-4">
                            {!editorRunDetail ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-400">点击一条 Temporal 运行记录查看详情</div> : (
                              <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)]">
                                <div className="space-y-2 rounded-2xl bg-slate-50 p-4 text-xs">
                                  <div className="flex items-center justify-between"><span className="text-slate-400">状态</span><Badge tone={toneForStatus(editorRunDetail.status)}>{editorRunStatusZh(editorRunDetail.status)}</Badge></div>
                                  <div className="flex items-center justify-between"><span className="text-slate-400">副作用</span><span className="text-slate-700">{editorRunDetail.sideEffects === "blocked" ? "已拦截" : editorRunDetail.sideEffects === "approval_gate" ? "审批门控" : "已授权"}</span></div>
                                  <div className="flex items-center justify-between"><span className="text-slate-400">已访问节点</span><span className="font-mono text-slate-700">{editorRunDetail.temporalState?.visitedNodeIds?.length ?? editorRunDetail.nodeRuns.length}</span></div>
                                  <div className="border-t border-slate-200 pt-2 text-[10px] leading-4 text-slate-500">{editorRunDetail.temporalState?.message ?? editorRunDetail.message}</div>
                                </div>
                                <div className="max-h-[500px] space-y-2 overflow-y-auto">
                                  {editorRunDetail.nodeRuns.length === 0 ? <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-400">运行已提交，等待工作器领取第一个节点</div> : editorRunDetail.nodeRuns.map((nodeRun, index) => (
                                    <div key={nodeRun.id} className="flex gap-3 rounded-xl border border-slate-200 p-3">
                                      <div className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold", nodeRun.status === "completed" ? "bg-emerald-100 text-emerald-700" : nodeRun.status === "failed" ? "bg-red-100 text-red-700" : nodeRun.status === "blocked" ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700")}>{index + 1}</div>
                                      <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-slate-800">{nodeRun.nodeLabel}</span><Badge tone={toneForStatus(nodeRun.status)}>{nodeRun.status === "blocked" ? "副作用已拦截" : nodeRun.status === "completed" ? "完成" : nodeRun.status === "failed" ? "失败" : "执行中"}</Badge>{nodeRun.sideEffectStatus !== "none" && <Badge tone="violet">{editorSideEffectStatusZh[nodeRun.sideEffectStatus]}</Badge>}</div><div className="mt-1 font-mono text-[10px] text-slate-400">{nodeRun.nodeId} · 尝试 {nodeRun.attempt} · {formatTime(nodeRun.startedAt)}</div><div className="mt-1 text-xs text-slate-500">{nodeRun.error ?? nodeRun.message ?? "节点正在执行"}</div></div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      </div>
                    )}

                    {devTab === "rules" && (
                      <div className="space-y-4">
                        <Card>
                          <CardHeader><div><CardTitle>审批阈值</CardTitle><CardDescription>版本化规则集是单一事实源；每次保存发布新版本，并绑定后续工作流发布。</CardDescription></div>{rulesData?.version && <Badge tone="violet">{rulesData.version}</Badge>}</CardHeader>
                          <CardContent className="pt-4">
                            <div className="grid gap-3 lg:grid-cols-3">
                              {(rulesData?.thresholds ?? []).map((t) => (
                                <div key={t.kind} className="rounded-2xl border border-slate-200 p-4">
                                  <div className="flex items-center justify-between"><div className="text-sm font-semibold text-slate-800">{t.name}</div><Badge tone="blue">{t.kind}</Badge></div>
                                  <p className="mt-1 text-[11px] text-slate-400">{t.note}</p>
                                  <div className="mt-3 space-y-1.5 text-xs">
                                    <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2"><span className="text-emerald-700">≤ {t.auto}{t.unit} · 自动接受</span><Badge tone="green">自动</Badge></div>
                                    <div className="flex items-center justify-between rounded-lg bg-blue-50 px-3 py-2"><span className="text-blue-700">{t.auto}–{t.buyer}{t.unit} · 采购员/财务审批</span><Badge tone="blue">采购员</Badge></div>
                                    <div className="flex items-center justify-between rounded-lg bg-red-50 px-3 py-2"><span className="text-red-700">&gt; {t.buyer}{t.unit} · 采购经理审批</span><Badge tone="red">经理</Badge></div>
                                  </div>
                                  <div className="mt-3 flex items-end gap-2">
                                    <div><div className="text-[10px] text-slate-400">自动阈值</div><input value={ruleDrafts[t.kind]?.auto ?? String(t.auto)} onChange={(event) => setRuleDrafts((previous) => ({ ...previous, [t.kind]: { auto: event.target.value, buyer: previous[t.kind]?.buyer ?? String(t.buyer) } }))} type="number" min={0} className="mt-1 h-8 w-16 rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-slate-400" /></div>
                                    <div><div className="text-[10px] text-slate-400">采购员阈值</div><input value={ruleDrafts[t.kind]?.buyer ?? String(t.buyer)} onChange={(event) => setRuleDrafts((previous) => ({ ...previous, [t.kind]: { auto: previous[t.kind]?.auto ?? String(t.auto), buyer: event.target.value } }))} type="number" min={0} className="mt-1 h-8 w-16 rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-slate-400" /></div>
                                    <Button size="sm" variant="outline" className="ml-auto" onClick={() => void saveRule(t.kind)}>保存并生效</Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </CardContent>
                        </Card>
                        <Card>
                          <CardHeader><div><CardTitle>权限矩阵</CardTitle><CardDescription>员工能执行的动作与资源范围（由治理服务判定）。</CardDescription></div></CardHeader>
                          <CardContent className="overflow-x-auto pt-4">
                            <table className="w-full min-w-[520px] border-separate border-spacing-0 text-left text-sm">
                              <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400"><th className="border-b border-slate-100 px-3 py-2 font-medium">效果</th><th className="border-b border-slate-100 px-3 py-2 font-medium">动作</th><th className="border-b border-slate-100 px-3 py-2 font-medium">资源</th><th className="border-b border-slate-100 px-3 py-2 font-medium">说明</th></tr></thead>
                              <tbody>{employee.permissions.map((p, i) => (
                                <tr key={i}><td className="border-b border-slate-100 px-3 py-2.5"><Badge tone={p.effect === "allow" ? "green" : "red"}>{p.effect}</Badge></td><td className="border-b border-slate-100 px-3 py-2.5 font-mono text-xs text-slate-700">{p.action}</td><td className="border-b border-slate-100 px-3 py-2.5 font-mono text-xs text-slate-500">{p.resource}</td><td className="border-b border-slate-100 px-3 py-2.5 text-xs text-slate-500">{p.note ?? ""}</td></tr>
                              ))}</tbody>
                            </table>
                          </CardContent>
                        </Card>
                      </div>
                    )}

                    {devTab === "tests" && (
                      <Card>
                        <CardHeader><div><CardTitle>回归测试</CardTitle><CardDescription>每个场景喂给真实采购路径编排器，验证动态路由是否符合预期。</CardDescription></div></CardHeader>
                        <CardContent className="pt-4">
                          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                            {TEST_CASES.map((tc) => {
                              const r = testsResult[tc.id];
                              return (
                                <div key={tc.id} className="flex flex-col rounded-2xl border border-slate-200 p-4">
                                  <div className="flex items-center justify-between"><div className="text-sm font-semibold text-slate-800">{tc.name}</div><Badge tone="neutral">{tc.id}</Badge></div>
                                  <p className="mt-1 text-[11px] text-slate-400">{tc.desc}</p>
                                  {r ? (
                                    <div className="mt-3 space-y-1.5 rounded-xl bg-slate-50 p-2.5 text-[11px]">
                                      <div className="flex items-center justify-between"><span className="text-slate-400">入口</span><Badge tone={r.entry === "exception" ? "red" : "blue"}>{ENTRY_ZH[r.entry] ?? r.entry}</Badge></div>
                                      <div className="flex items-center justify-between"><span className="text-slate-400">执行工作流</span><span className="font-mono text-slate-700">{r.workflows.length ? r.workflows.join(", ") : "—"}</span></div>
                                      <div className="flex items-center justify-between"><span className="text-slate-400">跳过</span><span className="font-mono text-slate-500">{r.skipped.length ? r.skipped.join(", ") : "—"}</span></div>
                                      <p className="pt-1 text-[10px] leading-4 text-slate-500">{r.reason}</p>
                                    </div>
                                  ) : (
                                    <div className="mt-3 flex-1 rounded-xl border border-dashed border-slate-200" />
                                  )}
                                  <Button size="sm" variant={r ? "outline" : "default"} className="mt-3" disabled={testRunning === tc.id} onClick={() => void runTestCase(tc.id, tc.input)}>
                                    {testRunning === tc.id ? <><FlaskConical className="size-3.5 animate-pulse" />运行中…</> : <><FlaskConical className="size-3.5" />{r ? "重新运行" : "运行"}</>}
                                  </Button>
                                </div>
                              );
                            })}
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {devTab === "versions" && (
                      <Card>
                        <CardHeader>
                          <div><CardTitle>版本与发布</CardTitle><CardDescription>编辑 → 模拟 → 影子 → 审批 → 自动 → 发布，可回滚。</CardDescription></div>
                          <Button size="sm" disabled={editorRunBusy !== null} onClick={() => void publishEditor()}><Plus className="size-3.5" />{editorRunBusy === "publish" ? "发布中…" : "发布新版本"}</Button>
                        </CardHeader>
                        <CardContent className="pt-4">
                          <div className="space-y-2">
                            {editorVersions.map((v) => (
                              <div key={v.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 p-3.5">
                                <div className="flex size-9 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><History className="size-4" /></div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2"><span className="font-mono text-sm font-semibold text-slate-800">{v.version}</span>{v.current && <Badge tone="green">当前</Badge>}<span className="text-[11px] text-slate-400">{formatDateTime(v.createdAt)}</span><Badge tone="neutral">{v.workflowCount} 个工作流</Badge></div>
                                  <div className="mt-0.5 text-xs text-slate-500">{v.note}</div>
                                </div>
                                {v.current ? <Badge tone="green">已发布</Badge> : <Button size="sm" variant="outline" disabled={editorRunBusy !== null} onClick={() => void rollbackEditor(v.id)}><RotateCcw className="size-3.5" />{editorRunBusy === "rollback" ? "回滚中…" : "回滚"}</Button>}
                              </div>
                            ))}
                            {editorVersions.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-400">尚无发布版本</div>}
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {devTab === "logs" && (
                      <Card><CardHeader><div><CardTitle>运行日志</CardTitle><CardDescription>领域事件流（审计轨迹）。</CardDescription></div></CardHeader><CardContent className="pt-4"><div className="max-h-[520px] space-y-1 overflow-auto">
                        {events.filter((e) => e.employeeId === selectedId || !e.employeeId).map((e, i) => (
                          <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-xs hover:bg-slate-50"><span className="font-mono text-slate-400">{e.at.slice(11, 19)}</span><span className={cn("size-1.5 rounded-full", eventTone(e.type))} /><span className="text-slate-700">{eventLabel(e.type)}</span><span className="flex-1 truncate text-slate-400">{e.reason ?? e.taskId ?? ""}</span></div>
                        ))}
                      </div></CardContent></Card>
                    )}
                  </div>
                )}
              </>
            ) : (
              <Card><CardContent className="flex min-h-[360px] flex-col items-center justify-center text-center"><div className="flex size-12 items-center justify-center rounded-2xl bg-slate-100"><Sparkles className="size-5 text-slate-600" /></div><h3 className="mt-4 font-semibold text-slate-950">正在连接后端…</h3><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">请先启动 Console API（pnpm api，:4173）。</p></CardContent></Card>
            ))}
          </div>
        </main>
      </div>

      {showCreate && <CreateEmployeeWizard onClose={() => setShowCreate(false)} onCreated={onEmployeeCreated} />}

      {showCapPicker && <CapabilityPicker employeeId={selectedId} currentSkills={employee?.skills.map((s) => s.id) ?? []} currentTools={employee?.tools.map((t) => t.id) ?? []} onClose={() => setShowCapPicker(false)} onSaved={() => { setShowCapPicker(false); void loadEmployee(); }} />}

      {section !== "orders" && <ChatWidget />}

      {/* 异常详情抽屉：AI 已调查清楚，你只需做业务决定 */}
      {selectedExc && (() => {
        const exc = selectedExc;
        const risk = exceptionRiskZh(exc.severity);
        const c = (exc.context ?? {}) as Record<string, unknown>;
        const acts = exceptionActions(exc.type);
        const tabs: { id: "analysis" | "quotes" | "context" | "trace"; label: string }[] = [
          { id: "analysis", label: "AI 分析" },
          { id: "quotes", label: "报价详情" },
          { id: "context", label: "相关上下文" },
          { id: "trace", label: "执行轨迹" },
        ];
        return (
          <div className="fixed inset-0 z-40">
            <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" onClick={() => setSelectedExc(null)} />
            <div className="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-2xl">
              <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold text-slate-950">{exceptionTypeZh(exc.type)}</span>
                    <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{exc.objectId}</span>
                    <Badge tone={risk.tone}>{risk.label}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{exc.supplier ?? ""}{exc.item ? " · " + exc.item : ""} · 创建于 {exc.createdAt}</div>
                </div>
                <button onClick={() => setSelectedExc(null)} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"><X className="size-4" /></button>
              </div>
              <div className="flex gap-1 border-b border-slate-100 px-4 pt-2">
                {tabs.map((t) => (
                  <button key={t.id} onClick={() => setExcTab(t.id)} className={cn("rounded-t-lg border-b-2 px-3 py-2 text-xs font-medium transition", excTab === t.id ? "border-slate-950 text-slate-950" : "border-transparent text-slate-400 hover:text-slate-600")}>{t.label}</button>
                ))}
              </div>
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {excTab === "analysis" && (
                  <div className="space-y-4">
                    <div className="rounded-xl border border-slate-200 p-4">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400"><Sparkles className="size-3" />AI 调查结论</div>
                      <p className="mt-2 text-sm leading-6 text-slate-700">{exc.aiJudgment}</p>
                    </div>
                    <div className="rounded-xl border border-blue-100 bg-blue-50/60 p-4">
                      <div className="flex items-center gap-2 text-xs font-semibold text-blue-900"><Bot className="size-3.5" />AI 建议动作</div>
                      <p className="mt-1.5 text-sm text-blue-800">{exc.recommendedAction}</p>
                      <div className="mt-3 flex items-center gap-2">
                        <span className="text-[11px] text-blue-500">置信度</span>
                        <div className="h-1.5 w-28 overflow-hidden rounded-full bg-blue-100"><div className="h-full rounded-full bg-blue-500" style={{ width: `${Math.round((exc.confidence ?? 0.85) * 100)}%` }} /></div>
                        <span className="text-xs font-semibold text-blue-700">{Math.round((exc.confidence ?? 0.85) * 100)}%</span>
                      </div>
                    </div>
                    <div className="rounded-xl border border-slate-200 p-4">
                      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">风险判断</div>
                      <div className="mt-2 flex items-center gap-2"><Badge tone={risk.tone}>{risk.label}</Badge><span className="text-xs text-slate-500">{risk.reason}</span></div>
                      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-slate-500">
                        <div><div className="text-slate-400">负责人</div><div className="mt-0.5 font-medium text-slate-700">{exc.owner ?? "—"}</div></div>
                        <div><div className="text-slate-400">业务对象状态</div><div className="mt-0.5 font-medium text-slate-700">{exc.objectStatus ?? "—"}</div></div>
                        <div><div className="text-slate-400">业务对象类型</div><div className="mt-0.5 font-medium text-slate-700">{exc.objectType ?? "—"}</div></div>
                        <div><div className="text-slate-400">创建时间</div><div className="mt-0.5 font-medium text-slate-700">{exc.createdAt}</div></div>
                      </div>
                    </div>
                  </div>
                )}
                {excTab === "quotes" && (
                  <div className="space-y-3">
                    {exc.threeWay ? (
                      <div>
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">三单对照（Odoo 实时）</div>
                        {exceptionContextBlock(exc)}
                      </div>
                    ) : exc.quotes && exc.quotes.length ? (
                      <div>
                        <table className="w-full border-separate border-spacing-0 text-left text-xs">
                          <thead><tr className="text-[11px] uppercase tracking-wider text-slate-400">
                            <th className="border-b border-slate-100 px-2 py-1.5 font-medium">供应商</th>
                            <th className="border-b border-slate-100 px-2 py-1.5 font-medium">报价</th>
                            <th className="border-b border-slate-100 px-2 py-1.5 font-medium">交期</th>
                            <th className="border-b border-slate-100 px-2 py-1.5 font-medium">准时率</th>
                            <th className="border-b border-slate-100 px-2 py-1.5 font-medium">AI 评分</th>
                          </tr></thead>
                          <tbody>{exc.quotes.map((q, i) => (
                            <tr key={i} className={q.recommended ? "bg-blue-50/60" : ""}>
                              <td className="border-b border-slate-100 px-2 py-2 font-medium text-slate-700">{q.supplier}{q.recommended ? <Badge tone="blue" className="ml-1.5">AI推荐</Badge> : null}</td>
                              <td className="border-b border-slate-100 px-2 py-2 text-slate-600">{q.price === null ? "—" : `${q.currency ? `${q.currency} ` : ""}${q.price.toLocaleString()}`}</td>
                              <td className="border-b border-slate-100 px-2 py-2 text-slate-600">{q.leadTime}</td>
                              <td className="border-b border-slate-100 px-2 py-2 text-slate-600">{q.onTime}</td>
                              <td className="border-b border-slate-100 px-2 py-2"><span className="font-semibold text-blue-700">{q.score === null ? "—" : `${q.score}分`}</span></td>
                            </tr>
                          ))}</tbody>
                        </table>
                        <p className="mt-2 rounded-lg bg-slate-50 p-3 text-[11px] leading-5 text-slate-500">只展示异常上下文中已持久化的报价、交期、准时率和评分；缺少证据的字段保持空缺。</p>
                      </div>
                    ) : exc.type === "delivery_delay" ? (
                      <div>
                        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">交期详情</div>
                        {exceptionContextBlock(exc)}
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          {exceptionImpact(exc).slice(2).map((im, i) => (
                            <div key={i} className="rounded-xl bg-slate-50 px-3 py-2.5">
                              <div className="text-[11px] text-slate-400">{im.label}</div>
                              <div className={`mt-0.5 text-sm font-semibold ${im.tone ?? "text-slate-800"}`}>{im.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">暂无报价明细数据</div>
                    )}
                  </div>
                )}
                {excTab === "context" && (
                  <div className="space-y-3">
                    {Object.entries(c).filter(([, v]) => v != null && typeof v !== "object").map(([k, v]) => (
                      <div key={k} className="flex items-start justify-between gap-3 border-b border-slate-50 pb-2 text-xs">
                        <span className="shrink-0 text-slate-400">{k}</span>
                        <span className="max-w-[60%] break-all text-right font-mono text-slate-700">{String(v)}</span>
                      </div>
                    ))}
                    {exc.threeWay && <div className="rounded-xl bg-slate-50 p-3"><div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">三单对照（Odoo 实时）</div><pre className="whitespace-pre-wrap font-mono text-[11px] leading-5 text-slate-600">{JSON.stringify(exc.threeWay, null, 2)}</pre></div>}
                  </div>
                )}
                {excTab === "trace" && (
                  excTrace.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-slate-400">该业务对象暂无执行轨迹</div>
                  ) : (
                    <div>
                      {excTrace.map((e, i) => (
                        <div key={i} className="flex gap-3 px-1 py-1.5 text-xs">
                          <div className="flex flex-col items-center">
                            <div className={cn("mt-1.5 size-1.5 rounded-full", eventTone(e.type))} />
                            {i < excTrace.length - 1 && <div className="w-px flex-1 bg-slate-200" />}
                          </div>
                          <div className="min-w-0 flex-1 pb-1">
                            <div className="text-slate-700">{narrateEvent(e)}</div>
                            <div className="mt-0.5 text-[11px] text-slate-400">{e.at}{e.employeeId ? " · " + e.employeeId : ""}{e.taskId ? " · " + e.taskId : ""}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                )}
              </div>
              <div className="border-t border-slate-100 px-5 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => requestBizAction(exc, acts.main)}><Check className="size-3.5" />{acts.main.label}</Button>
                  {acts.secondary.map((a) => (
                    <Button key={a.label} variant="outline" size="sm" disabled={a.kind === "unsupported"} title={a.kind === "unsupported" ? a.hint : undefined} onClick={() => requestBizAction(exc, a)}>{a.label}{a.kind === "unsupported" ? "（尚未接入）" : ""}</Button>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-slate-400">{acts.main.hint}</p>
              </div>
            </div>
          </div>
        );
      })()}

      {operationNote && (
        <div className="fixed bottom-5 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl bg-slate-950 px-4 py-2.5 text-sm text-white shadow-xl" role="status">
          {operationNote}
        </div>
      )}

      {pendingBizAction && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-labelledby="biz-action-confirm-title">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600"><AlertTriangle className="size-5" /></div>
              <div className="min-w-0">
                <h2 id="biz-action-confirm-title" className="text-base font-semibold text-slate-950">确认执行{pendingBizAction.act.label}</h2>
                <p className="mt-1 text-sm leading-5 text-slate-600">此操作会更新真实采购异常状态，请确认后继续。</p>
              </div>
            </div>
            <div className="mt-4 rounded-xl bg-slate-50 p-3 text-sm">
              <div className="font-medium text-slate-800">{exceptionTypeZh(pendingBizAction.exc.type)}</div>
              <div className="mt-1 font-mono text-xs text-slate-500">{pendingBizAction.exc.objectId}</div>
              <div className="mt-2 text-xs text-slate-500">{pendingBizAction.exc.supplier ?? "未提供供应商"}{pendingBizAction.exc.item ? ` · ${pendingBizAction.exc.item}` : ""}</div>
            </div>
            {bizActionError && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-700" role="alert">{bizActionError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" disabled={bizActionBusy} onClick={() => { setPendingBizAction(null); setBizActionError(null); }}>取消</Button>
              <Button disabled={bizActionBusy} onClick={() => void runBizAction(pendingBizAction.exc, pendingBizAction.act)}>
                {bizActionBusy ? "提交中…" : "确认提交"}
              </Button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function CollaborationPanel({ compact = false }: { compact?: boolean }) {
  const [items, setItems] = useState<CollaborationWorkItem[]>([]);
  const [detail, setDetail] = useState<CollaborationWorkDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: "accept" | "dismiss" | "reassign"; token: string; key: string; role?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reassignRole, setReassignRole] = useState("");

  const loadWork = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiRequest<{ items: CollaborationWorkItem[] }>("/api/collaboration/my-work");
      setItems(response.items ?? []);
      if (selectedId && !(response.items ?? []).some((item) => item.id === selectedId)) {
        setSelectedId(null);
        setDetail(null);
      }
    } catch (cause) {
      const apiError = cause instanceof ReadyworkApiError ? cause : null;
      setError(apiError?.status === 503 ? "协作控制面尚未配置，当前无法加载我的任务。" : apiError?.message ?? "我的任务加载失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => { void loadWork(); }, [loadWork]);

  const selectItem = async (id: string) => {
    setSelectedId(id);
    setDetailLoading(true);
    setError(null);
    try {
      setDetail(await apiRequest<CollaborationWorkDetail>(`/api/collaboration/tasks/${encodeURIComponent(id)}`));
    } catch (cause) {
      const apiError = cause instanceof ReadyworkApiError ? cause : null;
      setError(apiError?.message ?? "任务详情加载失败，请稍后重试。");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const startAction = async (action: "accept" | "dismiss" | "reassign") => {
    if (!detail || busy || (action === "reassign" && !reassignRole.trim())) return;
    const key = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `web:${detail.id}:${action}:${Date.now()}`;
    const role = action === "reassign" ? reassignRole.trim() : undefined;
    setBusy(true);
    setError(null);
    try {
      const response = await apiRequest<{ ok: boolean; code?: string; confirmationToken?: string; error?: string }>(`/api/collaboration/tasks/${encodeURIComponent(detail.id)}/actions`, {
        method: "POST", headers: { "Idempotency-Key": key }, body: { action, ...(role ? { assigneeRole: role } : {}) },
      });
      if (response.code === "CONFIRMATION_REQUIRED" && response.confirmationToken) {
        setPending({ action, token: response.confirmationToken, key, ...(role ? { role } : {}) });
      } else if (response.ok) {
        await loadWork();
        if (action === "dismiss") { setSelectedId(null); setDetail(null); } else await selectItem(detail.id);
        setReassignRole("");
      } else {
        setError(response.error ?? "动作未完成，请稍后重试。");
      }
    } catch (cause) {
      const apiError = cause instanceof ReadyworkApiError ? cause : null;
      setError(apiError?.message ?? "动作提交失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const confirmAction = async () => {
    if (!detail || !pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiRequest<{ ok: boolean; error?: string }>(`/api/collaboration/tasks/${encodeURIComponent(detail.id)}/actions`, {
        method: "POST", headers: { "Idempotency-Key": pending.key }, body: { action: pending.action, confirmationToken: pending.token, ...(pending.role ? { assigneeRole: pending.role } : {}) },
      });
      if (!response.ok) throw new ReadyworkApiError(response.error ?? "确认未完成", 409, response);
      setPending(null);
      await loadWork();
      if (pending.action === "dismiss") { setSelectedId(null); setDetail(null); } else await selectItem(detail.id);
      setReassignRole("");
    } catch (cause) {
      const apiError = cause instanceof ReadyworkApiError ? cause : null;
      setError(apiError?.message ?? "确认提交失败，请重试；原动作仍未改变。");
    } finally {
      setBusy(false);
    }
  };

  const stateLabel: Record<CollaborationWorkItem["collaborationStatus"], string> = { open: "待处理", accepted: "已接受", dismissed: "已忽略", reassigned: "已转派" };
  return (
    <Card className={compact ? "border-slate-200 shadow-sm" : ""}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div><CardTitle>{compact ? "我的任务" : "我的协作任务"}</CardTitle><CardDescription>来自协作控制面的真实任务与状态。</CardDescription></div>
        <Button variant="outline" size="sm" onClick={() => void loadWork()} disabled={loading}><RotateCcw className={cn("size-3.5", loading && "animate-spin")} />刷新</Button>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {error && <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700" role="alert">{error}</div>}
        {loading && items.length === 0 && <div className="py-8 text-center text-xs text-slate-400">正在加载我的任务…</div>}
        {!loading && !error && items.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-400">当前没有分配给你的协作任务。</div>}
        {items.length > 0 && <div className="grid gap-3 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="space-y-2">
            {items.map((item) => <button type="button" key={item.id} onClick={() => void selectItem(item.id)} className={cn("w-full rounded-xl border p-3 text-left transition hover:border-slate-400", selectedId === item.id ? "border-slate-950 bg-slate-50" : "border-slate-200")}>
              <div className="flex items-center justify-between gap-2"><span className="truncate font-mono text-xs text-slate-700">{item.id}</span><Badge tone={toneForStatus(item.collaborationStatus)}>{stateLabel[item.collaborationStatus]}</Badge></div>
              <div className="mt-2 text-sm font-medium text-slate-800">{item.workflowId}</div><div className="mt-1 text-xs text-slate-500">业务对象：{item.businessObjectId}</div>
            </button>)}
          </div>
          <div className="min-h-40 rounded-xl border border-slate-200 bg-slate-50 p-4">
            {!selectedId && <div className="flex h-full items-center justify-center text-xs text-slate-400">选择一个任务查看详情</div>}
            {detailLoading && <div className="text-xs text-slate-400">正在加载任务详情…</div>}
            {detail && !detailLoading && <div className="space-y-3">
              <div><div className="text-sm font-semibold text-slate-900">任务详情</div><div className="mt-1 font-mono text-[11px] text-slate-500">{detail.id}</div></div>
              <div className="grid grid-cols-2 gap-2 text-xs"><div><span className="text-slate-400">工作流</span><div className="mt-1 text-slate-700">{detail.workflowId}</div></div><div><span className="text-slate-400">业务对象</span><div className="mt-1 text-slate-700">{detail.businessObjectId}</div></div><div><span className="text-slate-400">任务状态</span><div className="mt-1 text-slate-700">{detail.status}</div></div><div><span className="text-slate-400">当前分配</span><div className="mt-1 text-slate-700">{detail.assignment.humanId ?? detail.assignment.role ?? "未指定"}</div></div></div>
              {detail.approvals.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">该任务关联 {detail.approvals.length} 项审批。</div>}
              <details className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"><summary className="cursor-pointer text-slate-600">查看任务原始字段（已脱敏）</summary><pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all text-[10px] text-slate-500">{JSON.stringify(detail.task, null, 2)}</pre></details>
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3"><Button size="sm" onClick={() => void startAction("accept")} disabled={busy || detail.assignment.state !== "open"}><Check className="size-3.5" />接受</Button><Button size="sm" variant="outline" onClick={() => void startAction("dismiss")} disabled={busy || detail.assignment.state !== "open"}>忽略</Button><div className="flex min-w-[220px] flex-1 gap-2"><input value={reassignRole} onChange={(event) => setReassignRole(event.target.value)} placeholder="转派角色（如采购经理）" className="h-8 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-xs outline-none focus:border-slate-400" /><Button size="sm" variant="outline" onClick={() => void startAction("reassign")} disabled={busy || !reassignRole.trim()}>转派</Button></div></div>
            </div>}
          </div>
        </div>}
        {pending && detail && <div className="rounded-xl border border-blue-200 bg-blue-50 p-3"><div className="text-xs font-semibold text-blue-900">请确认“{pending.action === "accept" ? "接受" : pending.action === "dismiss" ? "忽略" : "转派"}”动作</div><p className="mt-1 text-[11px] leading-5 text-blue-700">确认后才会更新协作状态；重复点击不会重复提交。</p><div className="mt-2 flex gap-2"><Button size="sm" onClick={() => void confirmAction()} disabled={busy}>{busy ? "提交中…" : "确认执行"}</Button><Button size="sm" variant="outline" onClick={() => setPending(null)} disabled={busy}>取消</Button></div></div>}
      </CardContent>
    </Card>
  );
}

function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [showMyWork, setShowMyWork] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ text: string; actions: string[] } | null>(null);
  const [messages, setMessages] = useState<{ role: "user" | "assistant"; content: string; actions?: string[]; actionPlan?: { action: string; level: string; autoExecute: boolean; reason: string }[] }[]>([
    { role: "assistant", content: "你好，我是企业助手。可以查询公司数据，也可以下达控制指令。注意：我会先做权限判定，状态变更类操作（批准/驳回/发邮件/改交期等）需要你确认后才会执行。" },
  ]);

  const send = async (confirm = false) => {
    const text = confirm ? (pendingConfirm?.text ?? "") : input.trim();
    if (!text || sending) return;
    setInput("");
    setSending(true);
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: text }]);
    try {
      const r = await apiRequest<{ reply?: string; actions?: string[]; actionPlan?: { action: string; level: string; autoExecute: boolean; reason: string }[] }>("/api/chat", { method: "POST", body: { message: text, history, confirm } });
      const plan: { action: string; level: string; autoExecute: boolean; reason: string }[] = r.actionPlan ?? [];
      const needsConfirm = plan.some((p) => p.level === "confirm");
      setPendingConfirm(needsConfirm && !confirm ? { text, actions: plan.filter((p) => p.level === "confirm").map((p) => p.action) } : null);
      setMessages((m) => [...m, { role: "assistant", content: r.reply ?? "（无回复）", actions: r.actions ?? [], actionPlan: plan }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "聊天服务不可用，请确认后端已启动（pnpm api）。" }]);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <button onClick={() => setOpen((v) => !v)} className="fixed bottom-6 right-6 z-50 flex size-14 items-center justify-center rounded-full bg-slate-950 text-white shadow-lg transition hover:bg-slate-800">
        {open ? <X className="size-5" /> : <MessageSquareText className="size-5" />}
      </button>
      {open && (
        <div className="fixed bottom-24 right-6 z-50 flex h-[560px] w-[400px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div className="flex items-center gap-2"><div className="flex size-8 items-center justify-center rounded-full bg-slate-950 text-white"><Sparkles className="size-4" /></div><div><div className="text-sm font-semibold">企业助手</div><div className="text-[11px] text-slate-400">查询公司一切 · 控制 AI 员工</div></div></div>
            <div className="flex items-center gap-1"><Button variant={showMyWork ? "secondary" : "ghost"} size="sm" onClick={() => setShowMyWork((value) => !value)}><ListChecks className="size-3.5" />我的任务</Button><Button variant="ghost" size="icon" onClick={() => setOpen(false)}><X className="size-4" /></Button></div>
          </div>
          {showMyWork && <div className="max-h-[470px] overflow-y-auto border-b border-slate-100 p-3"><CollaborationPanel compact /></div>}
          <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 p-4">
            {messages.map((m, i) => (
              <div key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-6", m.role === "user" ? "bg-slate-950 text-white" : "border border-slate-200 bg-white text-slate-800")}>
                  {m.content}
                  {m.actionPlan && m.actionPlan.length > 0 && (
                    <div className="mt-2 space-y-1 rounded-lg bg-slate-50 p-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">权限判定</div>
                      {m.actionPlan.map((p, j) => (
                        <div key={j} className="flex items-center gap-1.5 text-[11px]">
                          <span>{p.autoExecute ? "✅" : p.level === "confirm" ? "🔶" : "⚠️"}</span>
                          <span className="font-mono text-slate-600">{p.action}</span>
                          <span className={cn("ml-auto", p.autoExecute ? "text-emerald-600" : p.level === "confirm" ? "text-blue-600" : "text-amber-600")}>{p.autoExecute ? "自动允许" : p.level === "confirm" ? "需确认" : "需审批"}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {sending && <div className="text-xs text-slate-400">正在思考…</div>}
          </div>
          {pendingConfirm && (
            <div className="border-t border-blue-100 bg-blue-50 px-4 py-3">
              <div className="text-xs font-semibold text-blue-900">以下状态变更操作需你确认后执行</div>
              <div className="mt-1 flex flex-wrap gap-1.5">{pendingConfirm.actions.map((a) => <span key={a} className="rounded-md bg-white px-1.5 py-0.5 font-mono text-[11px] text-blue-700 ring-1 ring-blue-200">{a}</span>)}</div>
              <div className="mt-2 flex gap-2">
                <Button size="sm" onClick={() => void send(true)} disabled={sending}><Check className="size-3.5" />确认执行</Button>
                <Button size="sm" variant="outline" onClick={() => setPendingConfirm(null)}>取消</Button>
              </div>
              <p className="mt-1.5 text-[10px] text-blue-400">AI 生成内容可能不准确，请核对后再确认。</p>
            </div>
          )}
          <div className="flex items-center gap-2 border-t border-slate-100 p-3">
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void send(); }} placeholder="问我，或让我控制员工…" className="h-10 flex-1 rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-slate-400" />
            <Button size="icon" onClick={() => void send()} disabled={sending || !input.trim()}><Send className="size-4" /></Button>
          </div>
        </div>
      )}
    </>
  );
}

function CapabilityPicker({ employeeId, currentSkills, currentTools, onClose, onSaved }: { employeeId: string; currentSkills: string[]; currentTools: string[]; onClose: () => void; onSaved: () => void }) {
  const [catalog, setCatalog] = useState<{ skills: { id: string; name: string }[]; tools: { id: string; name: string }[] } | null>(null);
  const [skills, setSkills] = useState<string[]>(currentSkills);
  const [tools, setTools] = useState<string[]>(currentTools);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiRequest<NonNullable<typeof catalog>>("/api/catalog").then(setCatalog).catch(() => {});
  }, []);

  const toggle = (list: string[], v: string, set: (x: string[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const save = async () => {
    setSaving(true);
    try {
      await apiRequest(`/api/employees/${employeeId}/capabilities`, { method: "POST", body: { add: { skills, tools } } });
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="w-full max-w-xl rounded-[28px] border border-white/40 bg-white p-6 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-violet-600"><WandSparkles className="size-3.5" />给员工加功能</div>
            <h2 className="mt-2 text-xl font-semibold">添加能力</h2>
            <p className="mt-1 text-sm text-slate-500">勾选要加入的技能与工具，保存后员工即可使用。</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="size-4" /></Button>
        </div>

        <div className="mt-5 space-y-4">
          <div>
            <div className="mb-2 text-xs font-medium text-slate-500">技能</div>
            <div className="flex flex-wrap gap-2">{(catalog?.skills ?? []).map((s) => <button key={s.id} onClick={() => toggle(skills, s.id, setSkills)} className={cn("rounded-xl border px-3 py-1.5 text-xs", skills.includes(s.id) ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 text-slate-600 hover:border-slate-400")}>{s.name}</button>)}</div>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium text-slate-500">工具</div>
            <div className="flex flex-wrap gap-2">{(catalog?.tools ?? []).map((t) => <button key={t.id} onClick={() => toggle(tools, t.id, setTools)} className={cn("rounded-xl border px-3 py-1.5 text-xs", tools.includes(t.id) ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 text-slate-600 hover:border-slate-400")}>{t.name}</button>)}</div>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存"}</Button>
        </div>
      </div>
    </div>
  );
}

function CreateEmployeeWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (created: { id?: string }) => void }) {
  const steps = ["岗位", "目标与 KPI", "上下文", "工作器", "技能与工具", "权限", "部署"];
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [step, setStep] = useState(0);
  const [catalog, setCatalog] = useState<{
    workers: { id: string; name: string; description: string }[];
    skills: { id: string; name: string }[];
    tools: { id: string; name: string; actions: string[] }[];
    contextTypes: string[];
    departments: { id: string; name: string }[];
  } | null>(null);
  const [form, setForm] = useState({
    name: "", role: "", departmentId: "dept:procurement",
    goalTitle: "", goalDescription: "", kpiName: "", kpiTarget: "", kpiUnit: "%",
    contextScope: [] as string[], workers: [] as string[], skills: [] as string[], tools: [] as string[],
    allowActions: [] as string[], denyActions: [] as string[],
    approvalRules: [] as { name: string; message: string }[],
    budgetCap: "", deployMode: "supervised" as DeployMode,
  });
  const [ruleName, setRuleName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    apiRequest<NonNullable<typeof catalog>>("/api/catalog").then(setCatalog).catch(() => {});
  }, []);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.querySelector<HTMLElement>("input, button, textarea, select")?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = (key: "contextScope" | "workers" | "skills" | "tools" | "allowActions" | "denyActions", value: string) =>
    setForm((f) => ({ ...f, [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value] }));

  const allActions = (catalog?.tools ?? []).flatMap((t) => t.actions.map((a) => `${t.id}.${a}`));

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const controls = [...dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.getAttribute("aria-hidden") !== "true");
    if (controls.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const submit = async () => {
    setCreating(true);
    try {
      const created = await apiRequest<{ id?: string }>("/api/employees/wizard", {
        method: "POST",
        body: {
          ...form,
          kpiTarget: Number(form.kpiTarget || 0),
          budgetCap: Number(form.budgetCap || 0),
        },
      });
      onCreated(created);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="create-employee-title" tabIndex={-1} className="w-full max-w-2xl rounded-[28px] border border-white/40 bg-white p-6 shadow-2xl" onKeyDown={handleDialogKeyDown} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium text-violet-600"><Sparkles className="size-3.5" />员工编译器</div>
            <h2 id="create-employee-title" className="mt-2 text-xl font-semibold">创建 AI 员工</h2>
            <p className="mt-1 text-sm text-slate-500">从岗位开始，逐项配置，而不是空白工作流。</p>
          </div>
          <Button variant="ghost" size="icon" aria-label="关闭创建 AI 员工" onClick={onClose}><X className="size-4" /></Button>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-1">
          {steps.map((s, i) => (
            <button key={s} onClick={() => i < step && setStep(i)} className={cn("rounded-lg px-2.5 py-1 text-[11px] font-medium", i === step ? "bg-slate-950 text-white" : i < step ? "bg-slate-100 text-slate-600" : "text-slate-400")}>{i + 1}. {s}</button>
          ))}
        </div>

        <div className="mt-5 min-h-[300px]">
          {step === 0 && (
            <div className="space-y-3">
              <label className="block"><div className="text-xs font-medium text-slate-500">员工名称 *</div><input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="如：供应商订单运营员工" className="mt-1 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-slate-400" /></label>
              <label className="block"><div className="text-xs font-medium text-slate-500">岗位职责</div><textarea value={form.role} onChange={(e) => set({ role: e.target.value })} placeholder="这个员工负责什么？" className="mt-1 h-20 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400" /></label>
              <label className="block"><div className="text-xs font-medium text-slate-500">所属部门</div><select value={form.departmentId} onChange={(e) => set({ departmentId: e.target.value })} className="mt-1 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none">{catalog?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-3">
              <label className="block"><div className="text-xs font-medium text-slate-500">目标标题</div><input value={form.goalTitle} onChange={(e) => set({ goalTitle: e.target.value })} placeholder="如：保证采购订单按期交付" className="mt-1 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none focus:border-slate-400" /></label>
              <label className="block"><div className="text-xs font-medium text-slate-500">目标描述</div><textarea value={form.goalDescription} onChange={(e) => set({ goalDescription: e.target.value })} placeholder="什么才叫完成得好？" className="mt-1 h-16 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400" /></label>
              <div className="grid grid-cols-3 gap-3">
                <label className="block"><div className="text-xs font-medium text-slate-500">KPI 名称</div><input value={form.kpiName} onChange={(e) => set({ kpiName: e.target.value })} placeholder="如：准时交付率" className="mt-1 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none" /></label>
                <label className="block"><div className="text-xs font-medium text-slate-500">目标值</div><input value={form.kpiTarget} onChange={(e) => set({ kpiTarget: e.target.value })} placeholder="98" className="mt-1 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none" /></label>
                <label className="block"><div className="text-xs font-medium text-slate-500">单位</div><input value={form.kpiUnit} onChange={(e) => set({ kpiUnit: e.target.value })} className="mt-1 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none" /></label>
              </div>
            </div>
          )}
          {step === 2 && (
            <div>
              <div className="mb-2 text-xs font-medium text-slate-500">它能读取哪些企业事实？（多选）</div>
              <div className="flex flex-wrap gap-2">{(catalog?.contextTypes ?? []).map((t) => <button key={t} onClick={() => toggle("contextScope", t)} className={cn("rounded-xl border px-3 py-1.5 text-xs", form.contextScope.includes(t) ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 text-slate-600 hover:border-slate-400")}>{t}</button>)}</div>
            </div>
          )}
          {step === 3 && (
            <div>
              <div className="mb-2 text-xs font-medium text-slate-500">内部由哪些专业执行单元协作？（多选）</div>
              <div className="space-y-2">{(catalog?.workers ?? []).map((w) => (
                <button key={w.id} onClick={() => toggle("workers", w.id)} className={cn("flex w-full items-center gap-3 rounded-xl border p-3 text-left", form.workers.includes(w.id) ? "border-slate-950 bg-slate-50" : "border-slate-200 hover:border-slate-400")}>
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100"><Blocks className="size-4" /></div>
                  <div className="min-w-0"><div className="text-sm font-medium">{w.name}</div><div className="truncate text-xs text-slate-500">{w.description}</div></div>
                  {form.workers.includes(w.id) && <Check className="ml-auto size-4 text-slate-900" />}
                </button>
              ))}</div>
            </div>
          )}
          {step === 4 && (
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-xs font-medium text-slate-500">技能（多选）</div>
                <div className="flex flex-wrap gap-2">{(catalog?.skills ?? []).map((s) => <button key={s.id} onClick={() => toggle("skills", s.id)} className={cn("rounded-xl border px-3 py-1.5 text-xs", form.skills.includes(s.id) ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 text-slate-600 hover:border-slate-400")}>{s.name}</button>)}</div>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium text-slate-500">工具（多选）</div>
                <div className="flex flex-wrap gap-2">{(catalog?.tools ?? []).map((t) => <button key={t.id} onClick={() => toggle("tools", t.id)} className={cn("rounded-xl border px-3 py-1.5 text-xs", form.tools.includes(t.id) ? "border-slate-950 bg-slate-950 text-white" : "border-slate-200 text-slate-600 hover:border-slate-400")}>{t.name}</button>)}</div>
              </div>
            </div>
          )}
          {step === 5 && (
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-xs font-medium text-slate-500">允许的动作（多选）</div>
                <div className="flex flex-wrap gap-1.5">{allActions.map((a) => <button key={a} onClick={() => toggle("allowActions", a)} className={cn("rounded-lg border px-2 py-1 font-mono text-[11px]", form.allowActions.includes(a) ? "border-emerald-600 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-500 hover:border-slate-400")}>{a}</button>)}</div>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium text-slate-500">禁止的动作（多选）</div>
                <div className="flex flex-wrap gap-1.5">{allActions.map((a) => <button key={a} onClick={() => toggle("denyActions", a)} className={cn("rounded-lg border px-2 py-1 font-mono text-[11px]", form.denyActions.includes(a) ? "border-red-600 bg-red-50 text-red-700" : "border-slate-200 text-slate-500 hover:border-slate-400")}>{a}</button>)}</div>
              </div>
              <div>
                <div className="mb-2 text-xs font-medium text-slate-500">审批规则</div>
                <div className="flex gap-2"><input value={ruleName} onChange={(e) => setRuleName(e.target.value)} placeholder="如：延期超过 7 天需审批" className="h-9 flex-1 rounded-xl border border-slate-200 px-3 text-sm outline-none" /><Button variant="outline" size="sm" onClick={() => { if (ruleName.trim()) { set({ approvalRules: [...form.approvalRules, { name: ruleName.trim(), message: ruleName.trim() }] }); setRuleName(""); } }}>添加</Button></div>
                <div className="mt-2 space-y-1">{form.approvalRules.map((r, i) => <div key={i} className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-1.5 text-xs"><span>{r.name}</span><button onClick={() => set({ approvalRules: form.approvalRules.filter((_, j) => j !== i) })}><X className="size-3 text-slate-400" /></button></div>)}</div>
              </div>
            </div>
          )}
          {step === 6 && (
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-xs font-medium text-slate-500">部署模式</div>
                <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 p-1">
                  {([["shadow", "影子"], ["supervised", "受监督"], ["autonomous", "自主"]] as [DeployMode, string][]).map(([id, label]) => (
                    <button key={id} onClick={() => set({ deployMode: id })} className={cn("flex-1 rounded-lg px-3 py-2 text-xs font-medium", form.deployMode === id ? "bg-white text-slate-950 shadow-sm" : "text-slate-500")}>{label}</button>
                  ))}
                </div>
              </div>
              <label className="block"><div className="text-xs font-medium text-slate-500">月度预算（CNY，可留空）</div><input value={form.budgetCap} onChange={(e) => set({ budgetCap: e.target.value })} placeholder="800" className="mt-1 h-10 w-full rounded-xl border border-slate-200 px-3 text-sm outline-none" /></label>
              <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">将创建员工「{form.name || "未命名"}」：{form.workers.length} 个工作器 · {form.skills.length} 项技能 · {form.tools.length} 个工具 · {form.approvalRules.length} 条审批规则</div>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-between">
          <Button variant="ghost" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>{step === 0 ? "取消" : "上一步"}</Button>
          {step < steps.length - 1 ? (
            <Button onClick={() => setStep(step + 1)} disabled={step === 0 && !form.name.trim()}>下一步 <ArrowRight className="size-4" /></Button>
          ) : (
            <Button onClick={() => void submit()} disabled={creating || !form.name.trim()}>{creating ? "创建中…" : "创建员工"} <Check className="size-4" /></Button>
          )}
        </div>
      </div>
    </div>
  );
}

function BriefcaseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect width="20" height="14" x="2" y="7" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  );
}
