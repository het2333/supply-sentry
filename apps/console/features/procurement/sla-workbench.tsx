"use client";

import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  FileClock,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  ShieldCheck,
  ShieldOff,
  TimerReset,
  Trash2,
  X,
} from "lucide-react";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { slaEvaluationEvidenceView } from "@/features/procurement/procurement-ui-state";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { cn } from "@/lib/utils";
import {
  READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS,
  READYWORK_PAGE_CONTAINER_CLASS,
  READYWORK_PAGE_TITLE_CLASS,
} from "@/features/procurement/visual-tokens";

type Route = "all" | "local" | "import" | "unclassified";
type Risk = "all" | "high" | "medium" | "low";
type Stage =
  | "po_sent"
  | "supplier_commitment"
  | "fulfilment_production"
  | "dispatch_transit"
  | "delivery_grn";
type Basis = "stage_entry" | "rihd";
type CalendarMode = "elapsed_hours" | "tenant_working_days";
type CommunicationChannel = "email" | "whatsapp";
type MessageCategory =
  | "acknowledgement_followup"
  | "production_progress_followup"
  | "dispatch_followup"
  | "delivery_status_escalation"
  | "grn_followup";
type EvaluationStatus =
  | "on_track"
  | "due_soon"
  | "in_grace"
  | "breached"
  | "escalated"
  | "blocked_missing_evidence"
  | "unmatched";
type Rule = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  route: Route;
  stage: Stage;
  risk: Risk;
  deadlineBasis: Basis;
  calendarMode: CalendarMode;
  targetOffsetHours: number;
  warningHours: number;
  graceHours: number;
  escalationAfterHours: number;
  followupIntervalHours: number;
  maxFollowups: number;
  escalationRole: string;
  messageCategory: MessageCategory;
  communicationChannel: CommunicationChannel;
};
type Policy = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "published" | "retired";
  version: number;
  rules: Rule[];
  createdBy: string;
  updatedBy: string;
  publishedBy: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};
type PolicyImpact = {
  policyId: string;
  policyVersion: number;
  policyStatus: Policy["status"];
  enabledRules: number;
  activePurchaseOrders: number;
  matchedPurchaseOrders: number;
  readyToEvaluate: number;
  missingDeadlineEvidence: number;
  unmatchedPurchaseOrders: number;
  byStage: Record<Stage, number>;
  byRoute: Record<Exclude<Route, "all">, number>;
};
type Evaluation = {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  supplierId: string | null;
  supplierName: string | null;
  policyId: string;
  policyVersion: number;
  policyName: string;
  ruleId: string | null;
  stage: Stage;
  status: EvaluationStatus;
  dueAt: string | null;
  graceUntil: string | null;
  nextFollowupAt: string | null;
  followupCount: number;
  evidence: Record<string, unknown>;
  fingerprint: string;
  version: number;
  evaluatedAt: string;
  updatedAt: string;
};
type EvaluationEvent = {
  id: string;
  purchaseOrderId: string;
  policyId: string;
  ruleId: string | null;
  action: "evaluation_created" | "evaluation_changed" | string;
  detail: Record<string, unknown>;
  createdAt: string;
};
type TenantCalendar = {
  mode: "tenant_working_days";
  timeZone: string;
  workingDays: number[];
  preferenceVersion: number | null;
  inheritedDefault: boolean;
};
type Payload = {
  policies: Policy[];
  publishedPolicy: Policy | null;
  draftPolicies: Policy[];
  policyImpacts: PolicyImpact[];
  evaluations: {
    items: Evaluation[];
    total: number;
    counts: Record<EvaluationStatus, number>;
  };
  evaluationEvents: EvaluationEvent[];
  events: Array<{
    policyId: string;
    actorId: string;
    action: string;
    detail: Record<string, unknown>;
    createdAt: string;
  }>;
  tenantCalendar: TenantCalendar;
  permissions: { operate: boolean; approve: boolean; configure: boolean };
};
type AutomationCounts = {
  created?: number;
  examined?: number;
  skippedWithoutRecipient?: number;
};
type AutomationRun = {
  id: string;
  workerId: string;
  status: "running" | "completed" | "failed" | "abandoned";
  startedAt: string;
  completedAt: string | null;
  result: AutomationCounts | null;
  error: string | null;
};
type AutomationPayload = {
  policy: { id: string; version: number; name: string } | null;
  status:
    | "waiting_for_policy"
    | "running"
    | "failed"
    | "scheduled"
    | "not_started";
  enabled: boolean;
  intervalSeconds: number | null;
  nextRunAt: string | null;
  leaseExpiresAt: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastStatus: string | null;
  lastResult: AutomationCounts | null;
  lastError: string | null;
  consecutiveFailures: number;
  runs: AutomationRun[];
};
type RuleEditorState = {
  mode: "add" | "edit";
  sourceRuleId: string | null;
  value: Rule;
};
type RefreshRequired = {
  reason: "conflict" | "uncertain" | "reload";
  currentVersion: number | null;
};
type RuleEditorReturnFocusTarget =
  | { kind: "add" }
  | { kind: "direct-edit"; ruleId: string }
  | { kind: "rule-menu"; ruleId: string };

const stageLabel: Record<Stage, string> = {
  po_sent: "PO 发出",
  supplier_commitment: "供应商承诺",
  fulfilment_production: "履约 / 生产",
  dispatch_transit: "发运 / 在途",
  delivery_grn: "交付 / 收货",
};
const routeLabel: Record<Route, string> = {
  all: "全部路线",
  local: "本地采购",
  import: "进口采购",
  unclassified: "未分类",
};
const appliesToLabel: Record<Route, string> = {
  all: "所有供应商",
  local: "本地供应商",
  import: "进口供应商",
  unclassified: "未分类供应商",
};
const riskLabel: Record<Risk, string> = {
  all: "全部风险",
  high: "高风险",
  medium: "中风险",
  low: "低风险",
};
const basisLabel: Record<Basis, string> = {
  stage_entry: "阶段进入时间",
  rihd: "要求到货日 RIHD",
};
const calendarModeLabel: Record<CalendarMode, string> = {
  elapsed_hours: "自然小时",
  tenant_working_days: "租户工作日",
};
const weekdayLabel: Record<number, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};
const categoryLabel: Record<MessageCategory, string> = {
  acknowledgement_followup: "催供应商确认",
  production_progress_followup: "催生产进度",
  dispatch_followup: "催发运",
  delivery_status_escalation: "交付风险升级",
  grn_followup: "催收货 / GRN",
};
const communicationChannelLabel: Record<CommunicationChannel, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
};
const statusLabel: Record<EvaluationStatus, string> = {
  on_track: "正常",
  due_soon: "即将到期",
  in_grace: "宽限期",
  breached: "已违约",
  escalated: "已升级",
  blocked_missing_evidence: "缺少证据",
  unmatched: "未匹配",
};
const statusTone: Record<EvaluationStatus, string> = {
  on_track: "bg-emerald-50 text-emerald-700",
  due_soon: "bg-blue-50 text-blue-700",
  in_grace: "bg-amber-50 text-amber-700",
  breached: "bg-red-50 text-red-600",
  escalated: "bg-red-600 text-white",
  blocked_missing_evidence: "bg-slate-100 text-slate-600",
  unmatched: "bg-violet-50 text-violet-700",
};
const automationStatusLabel: Record<AutomationPayload["status"], string> = {
  waiting_for_policy: "等待策略发布",
  running: "正在检查",
  failed: "上次运行失败",
  scheduled: "已计划",
  not_started: "尚未启动",
};

const v1Template: Rule[] = [
  {
    id: "po-sent-default",
    name: "PO 发出检查",
    description: "Purchase order sent for supplier action",
    enabled: true,
    route: "all",
    stage: "po_sent",
    risk: "all",
    deadlineBasis: "stage_entry",
    calendarMode: "elapsed_hours",
    targetOffsetHours: 1,
    warningHours: 0,
    graceHours: 1,
    escalationAfterHours: 2,
    followupIntervalHours: 12,
    maxFollowups: 2,
    escalationRole: "采购经理",
    messageCategory: "acknowledgement_followup",
    communicationChannel: "email",
  },
  {
    id: "supplier-commitment-default",
    name: "供应商确认期限",
    description: "Supplier to acknowledge PO",
    enabled: true,
    route: "all",
    stage: "supplier_commitment",
    risk: "all",
    deadlineBasis: "stage_entry",
    calendarMode: "elapsed_hours",
    targetOffsetHours: 24,
    warningHours: 4,
    graceHours: 4,
    escalationAfterHours: 28,
    followupIntervalHours: 24,
    maxFollowups: 3,
    escalationRole: "采购经理",
    messageCategory: "acknowledgement_followup",
    communicationChannel: "email",
  },
  {
    id: "production-progress-default",
    name: "生产进度检查窗口",
    description: "Supplier production progress update",
    enabled: true,
    route: "all",
    stage: "fulfilment_production",
    risk: "all",
    deadlineBasis: "rihd",
    calendarMode: "elapsed_hours",
    targetOffsetHours: -168,
    warningHours: 48,
    graceHours: 24,
    escalationAfterHours: -144,
    followupIntervalHours: 48,
    maxFollowups: 3,
    escalationRole: "采购经理",
    messageCategory: "production_progress_followup",
    communicationChannel: "email",
  },
  {
    id: "dispatch-default",
    name: "发运确认窗口",
    description: "Supplier dispatch confirmation",
    enabled: true,
    route: "all",
    stage: "dispatch_transit",
    risk: "all",
    deadlineBasis: "rihd",
    calendarMode: "elapsed_hours",
    targetOffsetHours: -72,
    warningHours: 24,
    graceHours: 12,
    escalationAfterHours: -60,
    followupIntervalHours: 24,
    maxFollowups: 3,
    escalationRole: "采购经理",
    messageCategory: "dispatch_followup",
    communicationChannel: "email",
  },
  {
    id: "delivery-grn-default",
    name: "到货与 GRN 核验",
    description: "Goods receipt confirmation",
    enabled: true,
    route: "all",
    stage: "delivery_grn",
    risk: "all",
    deadlineBasis: "rihd",
    calendarMode: "elapsed_hours",
    targetOffsetHours: 24,
    warningHours: 12,
    graceHours: 24,
    escalationAfterHours: 48,
    followupIntervalHours: 24,
    maxFollowups: 2,
    escalationRole: "采购经理",
    messageCategory: "grn_followup",
    communicationChannel: "email",
  },
];

function ruleMatchKey(rule: Pick<Rule, "route" | "stage" | "risk">): string {
  return `${rule.route}:${rule.stage}:${rule.risk}`;
}

function hasDuplicateEnabledMatch(
  candidate: Rule,
  existingRules: Rule[],
  sourceRuleId: string | null,
): boolean {
  if (!candidate.enabled) return false;
  const candidateKey = ruleMatchKey(candidate);
  return existingRules.some((rule) =>
    rule.id !== sourceRuleId && rule.enabled && ruleMatchKey(rule) === candidateKey);
}

function sameRule(left: Rule, right: Rule): boolean {
  return JSON.stringify([
    left.id,
    left.name,
    left.description,
    left.enabled,
    left.route,
    left.stage,
    left.risk,
    left.deadlineBasis,
    left.calendarMode,
    left.targetOffsetHours,
    left.warningHours,
    left.graceHours,
    left.escalationAfterHours,
    left.followupIntervalHours,
    left.maxFollowups,
    left.escalationRole,
    left.messageCategory,
    left.communicationChannel,
  ]) === JSON.stringify([
    right.id,
    right.name,
    right.description,
    right.enabled,
    right.route,
    right.stage,
    right.risk,
    right.deadlineBasis,
    right.calendarMode,
    right.targetOffsetHours,
    right.warningHours,
    right.graceHours,
    right.escalationAfterHours,
    right.followupIntervalHours,
    right.maxFollowups,
    right.escalationRole,
    right.messageCategory,
    right.communicationChannel,
  ]);
}

function blankRule(existingRules: Rule[]): Rule {
  const preferredTemplates = [
    v1Template[1]!,
    ...v1Template.filter((_, index) => index !== 1),
  ];
  const template = preferredTemplates.find((candidate) =>
    !hasDuplicateEnabledMatch(candidate, existingRules, null));
  return {
    ...(template ?? v1Template[1]!),
    id: clientRuleId(),
    name: "",
    description: "",
    enabled: Boolean(template),
    targetOffsetHours: 48,
    graceHours: 24,
    escalationAfterHours: 72,
  };
}

function clientRuleId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `rule-${uuid}`
    : `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function durationLabel(hours: number): string {
  const absolute = Math.abs(hours);
  const sign = hours < 0 ? "-" : "";
  if (absolute === 0) return "0h";
  if (absolute % 24 === 0) return `${sign}${absolute / 24}d`;
  if (absolute > 24) return `${sign}${Math.floor(absolute / 24)}d ${absolute % 24}h`;
  return `${sign}${absolute}h`;
}

function dayValue(hours: number): number {
  return Math.round((hours / 24) * 1000) / 1000;
}

function dayLabel(hours: number): string {
  const days = dayValue(hours);
  return `${days} 天`;
}

function errorText(error: unknown): string {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 401) return "登录已过期，请重新登录后再读取 SLA 配置。";
    if (error.status === 403) return "当前账号没有查看 SLA 配置的权限。";
    if (error.status === 409) return "SLA 策略已被其他人更新，请保留当前输入并刷新后重试。";
    if (error.status === 422) return "SLA 规则未通过校验，请检查输入后重试。";
    if (error.status === 503) return "SLA 配置暂时不可用，请稍后重试。";
    return error.message;
  }
  return error instanceof Error ? error.message : "SLA 数据读取失败";
}
function refreshRequirementText(refreshRequired: RefreshRequired): string {
  if (refreshRequired.reason === "conflict") {
    return refreshRequired.currentVersion === null
      ? "服务端状态已变更，重试前必须重新读取。"
      : `服务端当前版本 v${refreshRequired.currentVersion}，重试前必须重新读取。`;
  }
  if (refreshRequired.reason === "uncertain") {
    return "上次写入结果未知，重试前必须重新读取。";
  }
  return refreshRequired.currentVersion === null
    ? "写入已接受，但最新权威状态尚未读回，重试前必须重新读取。"
    : `写入已接受，服务端返回 v${refreshRequired.currentVersion}；最新权威状态读回前不会再次提交。`;
}
function offsetLabel(rule: Rule): string {
  const prefix = rule.targetOffsetHours > 0 ? "+" : "";
  return `${basisLabel[rule.deadlineBasis]} ${prefix}${rule.targetOffsetHours}h · ${calendarModeLabel[rule.calendarMode]}`;
}

export function ProcurementSlaWorkbench() {
  const { formatShortDateTime: formatDate } = useProcurementLocale();
  const [data, setData] = useState<Payload | null>(null);
  const [automation, setAutomation] = useState<AutomationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState<RefreshRequired | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftRules, setDraftRules] = useState<Rule[]>([]);
  const [ruleQuery, setRuleQuery] = useState("");
  const [ruleRoute, setRuleRoute] = useState<"any" | Route>("any");
  const [ruleStatus, setRuleStatus] = useState<"all" | "active" | "inactive">("all");
  const [governanceMode] = useState(() =>
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("slaGovernance") === "1",
  );
  const [governanceOpen, setGovernanceOpen] = useState(false);
  const [ruleEditor, setRuleEditor] = useState<RuleEditorState | null>(null);
  const [openRuleMenuId, setOpenRuleMenuId] = useState<string | null>(null);
  const [pendingRuleDeletion, setPendingRuleDeletion] = useState<Rule | null>(null);
  const [publishConfirm, setPublishConfirm] = useState(false);
  const [retireConfirm, setRetireConfirm] = useState(false);
  const [expandedEvaluationId, setExpandedEvaluationId] = useState<
    string | null
  >(null);
  const abortRef = useRef<AbortController | null>(null);
  const addRuleButtonRef = useRef<HTMLButtonElement | null>(null);
  const ruleEditTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const ruleMenuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const ruleEditorReturnFocusRef = useRef<RuleEditorReturnFocusTarget | null>(null);
  const publishTriggerRef = useRef<HTMLButtonElement | null>(null);
  const retireTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mutationInFlightRef = useRef(new Set<string>());
  const preserveDraftInputOnNextLoadRef = useRef(false);
  const reviewedRuleRef = useRef<Rule | null>(null);
  useEffect(() => {
    reviewedRuleRef.current = ruleEditor?.value ?? null;
  }, [ruleEditor]);

  function beginMutation(action: string): boolean {
    if (mutationInFlightRef.current.has(action)) return false;
    mutationInFlightRef.current.add(action);
    return true;
  }

  function finishMutation(action: string): void {
    mutationInFlightRef.current.delete(action);
  }

  function recordMutationFailure(cause: unknown, forbiddenMessage?: string): void {
    setError(
      cause instanceof ReadyworkApiError && cause.status === 403 && forbiddenMessage
        ? forbiddenMessage
        : errorText(cause),
    );
    if (!(cause instanceof ReadyworkApiError)) return;
    if (cause.status === 403) {
      setData((current) => current
        ? {
            ...current,
            permissions: { operate: false, approve: false, configure: false },
          }
        : current);
      return;
    }
    const payload = cause.payload && typeof cause.payload === "object"
      ? cause.payload as Record<string, unknown>
      : null;
    const currentVersion = typeof payload?.["currentVersion"] === "number"
      && Number.isSafeInteger(payload["currentVersion"])
      ? payload["currentVersion"] as number
      : null;
    if (cause.status === 409 || cause.status === 404) {
      preserveDraftInputOnNextLoadRef.current = Boolean(selectedDraft || ruleEditor);
      setRefreshRequired({ reason: "conflict", currentVersion });
    } else if (cause.status === 0 || cause.status === 408) {
      preserveDraftInputOnNextLoadRef.current = Boolean(selectedDraft || ruleEditor);
      setRefreshRequired({ reason: "uncertain", currentVersion: null });
    }
  }

  const load = useCallback(async (): Promise<boolean> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setReadError(null);
    setAutomationError(null);
    let authorityLoaded = false;
    try {
      const [slaResult, automationResult] = await Promise.allSettled([
        apiRequest<Payload>("/api/procurement/sla", {
          signal: controller.signal,
        }),
        apiRequest<AutomationPayload>("/api/procurement/sla/automation", {
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted) return false;
      if (slaResult.status === "fulfilled") {
        authorityLoaded = true;
        setData(slaResult.value);
        setError(null);
        setRefreshRequired(null);
      } else {
        setReadError(errorText(slaResult.reason));
      }
      if (automationResult.status === "fulfilled") {
        setAutomation(automationResult.value);
      } else {
        setAutomationError(
          "自动 SLA 检查状态暂时不可用，基础 SLA 规则仍以已成功读取的权威数据为准。",
        );
      }
    } catch (cause) {
      if (!controller.signal.aborted) setReadError(errorText(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
      if (abortRef.current === controller) abortRef.current = null;
    }
    return authorityLoaded;
  }, []);
  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);
  useEffect(() => {
    if (!openRuleMenuId) return;
    const closeMenu = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const menu = target.closest("[data-sla-rule-menu]");
      if (menu?.getAttribute("data-sla-rule-menu") !== openRuleMenuId) {
        setOpenRuleMenuId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenRuleMenuId(null);
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openRuleMenuId]);
  useEffect(() => {
    if (!openRuleMenuId) return;
    window.requestAnimationFrame(() => {
      const container = document.querySelector(
        `[data-sla-rule-menu="${openRuleMenuId}"]`,
      );
      container?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
  }, [openRuleMenuId]);

  const selectedDraft =
    data?.draftPolicies.find((policy) => policy.id === selectedDraftId) ??
    data?.draftPolicies[0] ??
    null;
  useEffect(() => {
    if (!selectedDraft) {
      setSelectedDraftId(null);
      setDraftName("");
      setDraftDescription("");
      setDraftRules([]);
      return;
    }
    setSelectedDraftId(selectedDraft.id);
    if (preserveDraftInputOnNextLoadRef.current) {
      preserveDraftInputOnNextLoadRef.current = false;
      const reviewedRule = reviewedRuleRef.current;
      const authoritativeRule = reviewedRule
        ? selectedDraft.rules.find((rule) => rule.id === reviewedRule.id) ?? null
        : null;
      if (reviewedRule && authoritativeRule && sameRule(reviewedRule, authoritativeRule)) {
        setDraftRules((current) => {
          const found = current.some((rule) => rule.id === authoritativeRule.id);
          return found
            ? current.map((rule) => rule.id === authoritativeRule.id ? { ...authoritativeRule } : rule)
            : [...current, { ...authoritativeRule }];
        });
      }
      return;
    }
    setDraftName(selectedDraft.name);
    setDraftDescription(selectedDraft.description);
    setDraftRules(selectedDraft.rules.map((rule) => ({ ...rule })));
  }, [selectedDraft]);

  async function reloadAfterMutation(currentVersion: number | null = null): Promise<boolean> {
    const loaded = await load();
    if (loaded) return true;
    preserveDraftInputOnNextLoadRef.current = Boolean(selectedDraft || ruleEditor);
    setError("写入已由服务端接受，但最新权威 SLA 状态尚未读回；重新读取前不会再次提交。");
    setRefreshRequired({ reason: "reload", currentVersion });
    return false;
  }

  async function createDraft(source?: Policy) {
    if (refreshRequired || data?.permissions.configure !== true) return;
    if (!beginMutation("create")) return;
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const body = source
        ? {
            name: `${source.name} · 新版本`,
            description: source.description,
            sourcePolicyId: source.id,
          }
        : {
            name: "采购执行 SLA V1",
            description:
              "Readywork V1 五阶段建议模板；发布前请按供应商、路线和内部职责复核。",
            rules: v1Template,
          };
      const response = await apiRequest<{ item: Policy }>(
        "/api/procurement/sla/policies",
        { method: "POST", body },
      );
      if (!(await reloadAfterMutation(response.item.version))) return;
      setSelectedDraftId(response.item.id);
      setNotice("SLA 草稿已持久化，尚未影响运行中的采购订单。");
    } catch (cause) {
      recordMutationFailure(cause, "当前账号没有修改 SLA 配置的权限。");
    } finally {
      finishMutation("create");
      setBusy(null);
    }
  }
  function updateRule(index: number, patch: Partial<Rule>) {
    if (data?.permissions.configure !== true) return;
    setDraftRules((current) =>
      current.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, ...patch } : rule,
      ),
    );
  }
  function addRule() {
    if (data?.permissions.configure !== true) return;
    setDraftRules((current) => [...current, blankRule(current)]);
  }
  function openGovernance() {
    setGovernanceOpen(true);
    window.requestAnimationFrame(() =>
      document.getElementById("sla-governance")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      }),
    );
  }
  function addRuleFromDirectory() {
    if (data?.permissions.configure !== true) return;
    setOpenRuleMenuId(null);
    ruleEditorReturnFocusRef.current = { kind: "add" };
    setRuleEditor({
      mode: "add",
      sourceRuleId: null,
      value: blankRule(directoryRules),
    });
  }
  function editDirectoryRule(
    rule: Rule,
    triggerKind: "direct-edit" | "rule-menu",
  ) {
    if (data?.permissions.configure !== true) return;
    ruleEditorReturnFocusRef.current = { kind: triggerKind, ruleId: rule.id };
    setOpenRuleMenuId(null);
    setRuleEditor({ mode: "edit", sourceRuleId: rule.id, value: { ...rule } });
  }
  function resolveRuleEditorReturnFocus(): HTMLElement | null {
    const target = ruleEditorReturnFocusRef.current;
    if (!target || target.kind === "add") return addRuleButtonRef.current;
    if (target.kind === "direct-edit") {
      return ruleEditTriggerRefs.current.get(target.ruleId) ?? addRuleButtonRef.current;
    }
    return ruleMenuTriggerRefs.current.get(target.ruleId) ?? addRuleButtonRef.current;
  }
  function handleRuleMenuKeyDown(
    event: ReactKeyboardEvent<HTMLDivElement>,
    ruleId: string,
  ) {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .filter((item) => !item.disabled);
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (event.key === "Escape") {
      event.preventDefault();
      setOpenRuleMenuId(null);
      window.requestAnimationFrame(() => ruleMenuTriggerRefs.current.get(ruleId)?.focus());
      return;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      items[nextIndex]?.focus();
    }
  }
  async function persistDerivedDraft(
    rules: Rule[],
    successNotice: string,
  ): Promise<boolean> {
    if (data?.permissions.configure !== true) return false;
    if (selectedDraft) {
      const response = await apiRequest<{ item: Policy }>(
        `/api/procurement/sla/policies/${encodeURIComponent(selectedDraft.id)}`,
        {
          method: "PATCH",
          body: {
            expectedVersion: selectedDraft.version,
            name: draftName,
            description: draftDescription,
            rules,
          },
        },
      );
      if (!(await reloadAfterMutation(response.item.version))) return false;
      setSelectedDraftId(response.item.id);
      setNotice(successNotice);
      return true;
    }
    const source = data?.publishedPolicy ?? null;
    const response = await apiRequest<{ item: Policy }>("/api/procurement/sla/policies", {
      method: "POST",
      body: {
        name: source ? `${source.name} · 新版本` : "采购执行 SLA",
        description: source?.description ?? "采购执行 SLA 规则草稿；发布前不影响真实 PO。",
        rules,
      },
    });
    if (!(await reloadAfterMutation(response.item.version))) return false;
    setSelectedDraftId(response.item.id);
    setNotice(successNotice);
    return true;
  }
  async function applyRuleEditor() {
    if (
      refreshRequired ||
      data?.permissions.configure !== true ||
      !ruleEditor ||
      !ruleEditor.value.name.trim() ||
      !ruleEditor.value.description.trim() ||
      !ruleEditor.value.escalationRole.trim() ||
      ruleEditor.value.escalationAfterHours <
        ruleEditor.value.targetOffsetHours + ruleEditor.value.graceHours ||
      hasDuplicateEnabledMatch(
        ruleEditor.value,
        selectedDraft ? draftRules : data?.publishedPolicy?.rules ?? [],
        ruleEditor.sourceRuleId,
      )
    ) return;
    if (!beginMutation("save-rule")) return;
    const nextRule = {
      ...ruleEditor.value,
      name: ruleEditor.value.name.trim(),
      description: ruleEditor.value.description.trim(),
      escalationRole: ruleEditor.value.escalationRole.trim(),
    };
    setBusy("save-rule");
    setError(null);
    setNotice(null);
    try {
      const sourceRules = (selectedDraft ? draftRules : data?.publishedPolicy?.rules ?? [])
        .map((rule) => ({ ...rule }));
      const rules = ruleEditor.mode === "add"
        ? [...sourceRules, nextRule]
        : sourceRules.map((rule) => rule.id === ruleEditor.sourceRuleId ? nextRule : rule);
      const persisted = await persistDerivedDraft(
        rules,
        selectedDraft
          ? "SLA 规则已保存到版本化草稿。"
          : "规则已保存到新的版本化草稿；发布前不影响真实 PO。",
      );
      if (!persisted) return;
      setRuleEditor(null);
    } catch (cause) {
      recordMutationFailure(cause, "当前账号没有修改 SLA 配置的权限。");
    } finally {
      finishMutation("save-rule");
      setBusy(null);
    }
  }
  async function duplicateDirectoryRule(rule: Rule) {
    if (refreshRequired || data?.permissions.configure !== true) return;
    if (!beginMutation("duplicate-rule")) return;
    setOpenRuleMenuId(null);
    const duplicate = {
      ...rule,
      id: clientRuleId(),
      name: `${rule.name} · 副本`,
      enabled: false,
    };
    setBusy("duplicate-rule");
    setError(null);
    setNotice(null);
    try {
      const sourceRules = (selectedDraft ? draftRules : data?.publishedPolicy?.rules ?? [])
        .map((item) => ({ ...item }));
      const index = sourceRules.findIndex((item) => item.id === rule.id);
      const rules = index < 0
        ? [...sourceRules, duplicate]
        : [...sourceRules.slice(0, index + 1), duplicate, ...sourceRules.slice(index + 1)];
      await persistDerivedDraft(
        rules,
        selectedDraft
          ? "SLA 规则已在版本化草稿中复制。"
          : "规则副本已保存到新的版本化草稿；发布前不影响真实 PO。",
      );
    } catch (cause) {
      recordMutationFailure(cause);
    } finally {
      finishMutation("duplicate-rule");
      setBusy(null);
    }
  }
  async function confirmRuleDeletion() {
    if (
      refreshRequired ||
      data?.permissions.configure !== true ||
      !pendingRuleDeletion ||
      directoryRules.length <= 1
    ) return;
    if (!beginMutation("remove-rule")) return;
    const rule = pendingRuleDeletion;
    setBusy("remove-rule");
    setError(null);
    setNotice(null);
    try {
      const rules = (selectedDraft ? draftRules : data?.publishedPolicy?.rules ?? [])
        .filter((item) => item.id !== rule.id)
        .map((item) => ({ ...item }));
      await persistDerivedDraft(
        rules,
        selectedDraft
          ? "SLA 规则已从版本化草稿中删除。"
          : "已创建不含该规则的新版本化草稿；当前已发布策略没有被删除。",
      );
      setPendingRuleDeletion(null);
    } catch (cause) {
      recordMutationFailure(cause);
    } finally {
      finishMutation("remove-rule");
      setBusy(null);
    }
  }
  async function saveDraft() {
    if (refreshRequired || data?.permissions.configure !== true || !selectedDraft) return;
    if (!beginMutation("save")) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const response = await apiRequest<{ item: Policy }>(
        `/api/procurement/sla/policies/${encodeURIComponent(selectedDraft.id)}`,
        {
          method: "PATCH",
          body: {
            expectedVersion: selectedDraft.version,
            name: draftName,
            description: draftDescription,
            rules: draftRules,
          },
        },
      );
      if (!(await reloadAfterMutation(response.item.version))) return;
      setNotice("SLA 草稿已保存；发布前不会影响评估或外部沟通。");
    } catch (cause) {
      recordMutationFailure(cause);
    } finally {
      finishMutation("save");
      setBusy(null);
    }
  }
  async function publishDraft() {
    if (
      refreshRequired ||
      data?.permissions.configure !== true ||
      data.permissions.approve !== true ||
      !selectedDraft
    ) return;
    if (!beginMutation("publish")) return;
    setBusy("publish");
    setError(null);
    setNotice(null);
    try {
      const response = await apiRequest<{ item?: Policy }>(
        `/api/procurement/sla/policies/${encodeURIComponent(selectedDraft.id)}/publish`,
        { method: "POST", body: { expectedVersion: selectedDraft.version } },
      );
      setPublishConfirm(false);
      if (!(await reloadAfterMutation(response.item?.version ?? null))) return;
      setNotice("SLA 策略已发布，并已使用新版本重新评估所有活跃 PO。");
    } catch (cause) {
      recordMutationFailure(cause);
    } finally {
      finishMutation("publish");
      setBusy(null);
    }
  }
  async function evaluate() {
    if (refreshRequired || data?.permissions.operate !== true) return;
    if (!beginMutation("evaluate")) return;
    setBusy("evaluate");
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{ evaluated: number; changed: number }>(
        "/api/procurement/sla/evaluate",
        { method: "POST" },
      );
      if (!(await reloadAfterMutation())) return;
      setNotice(
        `已评估 ${result.evaluated} 张活跃 PO，${result.changed} 条 SLA 状态发生变化。`,
      );
    } catch (cause) {
      recordMutationFailure(cause);
    } finally {
      finishMutation("evaluate");
      setBusy(null);
    }
  }
  async function retirePolicy() {
    if (
      refreshRequired ||
      data?.permissions.configure !== true ||
      data.permissions.approve !== true ||
      !data.publishedPolicy
    ) return;
    if (!beginMutation("retire")) return;
    setBusy("retire");
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{ clearedEvaluations: number }>(
        `/api/procurement/sla/policies/${encodeURIComponent(data.publishedPolicy.id)}/retire`,
        {
          method: "POST",
          body: { expectedVersion: data.publishedPolicy.version },
        },
      );
      setRetireConfirm(false);
      if (!(await reloadAfterMutation())) return;
      setNotice(
        `SLA 策略已退役，${result.clearedEvaluations} 条当前评估投影已停止生效；历史策略、评估事件和审计记录继续保留。`,
      );
    } catch (cause) {
      recordMutationFailure(cause);
    } finally {
      finishMutation("retire");
      setBusy(null);
    }
  }
  async function runAutomation() {
    if (
      refreshRequired ||
      data?.permissions.operate !== true ||
      automationUnavailable ||
      !automation?.policy ||
      automation.status === "running"
    ) return;
    if (!beginMutation("automation")) return;
    setBusy("automation");
    setError(null);
    setNotice(null);
    try {
      const response = await apiRequest<{
        result: { status: string; result?: AutomationCounts };
        automation: AutomationPayload;
      }>("/api/procurement/sla/automation/run", { method: "POST" });
      setAutomation(response.automation);
      if (!(await reloadAfterMutation(response.automation.policy?.version ?? null))) return;
      const result = response.result.result;
      setNotice(
        `自动检查完成：检查 ${result?.examined ?? 0} 张 PO，生成 ${result?.created ?? 0} 份待审阅草稿，${result?.skippedWithoutRecipient ?? 0} 张因缺少真实收件人而安全跳过。`,
      );
    } catch (cause) {
      recordMutationFailure(cause);
    } finally {
      finishMutation("automation");
      setBusy(null);
    }
  }

  const counts = data?.evaluations.counts ?? {
    on_track: 0,
    due_soon: 0,
    in_grace: 0,
    breached: 0,
    escalated: 0,
    blocked_missing_evidence: 0,
    unmatched: 0,
  };
  const metrics = [
    {
      label: "已发布规则",
      value:
        data?.publishedPolicy?.rules.filter((rule) => rule.enabled).length ?? 0,
      detail: data?.publishedPolicy
        ? `当前生效 v${data.publishedPolicy.version}`
        : "尚无生效策略",
      icon: ShieldCheck,
      tone: "blue" as const,
    },
    {
      label: "正常",
      value: counts.on_track,
      detail: "当前计时范围内",
      icon: CheckCircle2,
      tone: "green" as const,
    },
    {
      label: "即将到期 / 宽限",
      value: counts.due_soon + counts.in_grace,
      detail: "需要提前关注",
      icon: Clock3,
      tone: "amber" as const,
    },
    {
      label: "已违约",
      value: counts.breached,
      detail: "等待跟进或处理",
      icon: AlertTriangle,
      tone: "red" as const,
    },
    {
      label: "已升级",
      value: counts.escalated,
      detail: "已超过自动跟进上限",
      icon: TimerReset,
      tone: "red" as const,
    },
  ];
  const unmatched = counts.blocked_missing_evidence + counts.unmatched;
  const evaluations = data?.evaluations.items ?? [];
  const selectedImpact = selectedDraft
    ? (data?.policyImpacts.find(
        (impact) => impact.policyId === selectedDraft.id,
      ) ?? null)
    : null;
  const publishedImpact = data?.publishedPolicy
    ? (data.policyImpacts.find(
        (impact) => impact.policyId === data.publishedPolicy!.id,
      ) ?? null)
    : null;
  const currentImpact = publishedImpact ?? selectedImpact;
  const hasUnsavedChanges = useMemo(
    () =>
      selectedDraft
        ? JSON.stringify({
            name: draftName,
            description: draftDescription,
            rules: draftRules,
          }) !==
          JSON.stringify({
            name: selectedDraft.name,
            description: selectedDraft.description,
            rules: selectedDraft.rules,
          })
        : false,
    [draftDescription, draftName, draftRules, selectedDraft],
  );
  const directoryRules = useMemo(
    () => selectedDraft ? draftRules : (data?.publishedPolicy?.rules ?? []),
    [data?.publishedPolicy?.rules, draftRules, selectedDraft],
  );
  const retiredPolicies = data?.policies.filter((policy) => policy.status === "retired") ?? [];
  const filteredDirectoryRules = useMemo(() => {
    const query = ruleQuery.trim().toLocaleLowerCase();
    return directoryRules.filter((rule) => {
      const status = rule.enabled ? "active" : "inactive";
      const text = [
        rule.name,
        rule.description,
        stageLabel[rule.stage],
        categoryLabel[rule.messageCategory],
        basisLabel[rule.deadlineBasis],
        appliesToLabel[rule.route],
        riskLabel[rule.risk],
        rule.escalationRole,
      ].join(" ").toLocaleLowerCase();
      return (!query || text.includes(query))
        && (ruleRoute === "any" || rule.route === ruleRoute)
        && (ruleStatus === "all" || status === ruleStatus);
    });
  }, [directoryRules, ruleQuery, ruleRoute, ruleStatus]);
  const automationUnavailable = automationError !== null && automation === null;

  return (
    <div className={cn(READYWORK_PAGE_CONTAINER_CLASS, "-mt-[14.5px] pb-16")}>
      <header className={cn("flex min-h-[134.5px] flex-wrap items-start justify-between gap-4", READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS)}>
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-[#8a94a6]">设置 <span className="px-1 text-[#c1c7d0]">/</span> <span className="text-[#4b5565]">SLA</span></div>
          <h1 className={cn(READYWORK_PAGE_TITLE_CLASS, "mt-2")}>SLA</h1>
          <p className="mt-1.5 max-w-3xl text-sm leading-6 text-slate-500">
            为采购流程配置服务级别协议（SLA）。
          </p>
        </div>
        {data?.permissions.configure && <button ref={addRuleButtonRef} type="button" onClick={addRuleFromDirectory} disabled={Boolean(busy)} className="mt-[11.5px] flex h-9 items-center gap-2 rounded-lg bg-[#2563eb] px-4 text-xs font-bold text-white shadow-sm shadow-blue-200 transition hover:bg-[#1d4ed8] disabled:opacity-50"><Plus className="size-4" />添加新规则</button>}
      </header>
      {readError && (
        <div
          role="alert"
          className="mt-4 flex gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            {data
              ? "刷新失败，以下保留上次成功读取的 SLA 策略。"
              : null}
            {data ? " " : null}
            <span data-preserve-language>{readError}</span>
          </span>
        </div>
      )}
      {error && (
        <div role="alert" className="mt-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 flex-1">
            <div data-preserve-language>{error}</div>
            {refreshRequired && (
              <div className="mt-2 flex flex-wrap items-center justify-between gap-3 border-t border-red-200 pt-2">
                <span className="text-xs">{refreshRequirementText(refreshRequired)}</span>
                <button type="button" onClick={() => void load()} aria-busy={loading} disabled={loading} className="h-8 rounded-lg border border-red-300 bg-white px-3 text-xs font-semibold text-red-700 disabled:opacity-50">
                  重新读取最新版本
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="mt-4 flex gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          {notice}
        </div>
      )}

      <section className="mt-5 overflow-hidden rounded-2xl border border-[#e1e6ed] bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2.5 p-4">
          <label className="relative min-w-[260px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#9aa3b2]" />
            <input aria-label="搜索 SLA 规则" value={ruleQuery} onChange={(event) => setRuleQuery(event.target.value)} placeholder="按流程、描述或供应商搜索…" className="h-9 w-full rounded-lg border border-[#dfe4eb] bg-white pl-9 pr-3 text-[13px] text-[#344057] outline-none transition focus:border-blue-400" />
          </label>
          <select aria-label="适用范围" value={ruleRoute} onChange={(event) => setRuleRoute(event.target.value as "any" | Route)} className="h-9 rounded-lg border border-[#dfe4eb] bg-white px-3 text-xs text-[#566176] outline-none">
            <option value="any">适用范围</option>
            {(["all", "local", "import"] as const).map((value) => <option key={value} value={value}>{appliesToLabel[value]}</option>)}
          </select>
          <select aria-label="状态" value={ruleStatus} onChange={(event) => setRuleStatus(event.target.value as typeof ruleStatus)} className="h-9 rounded-lg border border-[#dfe4eb] bg-white px-3 text-xs text-[#566176] outline-none">
            <option value="all">状态</option>
            <option value="active">启用</option>
            <option value="inactive">停用</option>
          </select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px] border-collapse text-left">
            <thead><tr className="border-y border-[#e7ebf0] bg-[#f8fafc] text-[11px] font-semibold text-[#7c8798]"><th className="px-4 py-3">流程 / 阶段</th><th className="px-4 py-3">描述</th><th className="px-4 py-3">SLA 目标</th><th className="px-4 py-3">宽限期</th><th className="px-4 py-3">升级时间</th><th className="px-4 py-3">适用范围</th><th className="px-4 py-3">状态</th><th className="w-28 px-4 py-3" /></tr></thead>
            <tbody>
              {data && filteredDirectoryRules.map((rule, index) => {
                const rowStatus = rule.enabled ? "active" : "inactive";
                return <tr key={rule.id} className={cn("border-b border-[#edf0f4] text-[13px] text-[#5d6879] transition hover:bg-[#f8fbff]", index % 2 === 1 && "bg-[#fbfcfd]")}>
                  <td data-preserve-language className="px-4 py-3.5 font-bold text-[#273247]">{rule.name}</td>
                  <td className="max-w-[310px] px-4 py-3.5"><div data-preserve-language className="truncate">{rule.description}</div></td>
                  <td className="px-4 py-3.5 font-semibold text-[#344057]">{dayLabel(rule.targetOffsetHours)}</td>
                  <td className="px-4 py-3.5">{dayLabel(rule.graceHours)}</td>
                  <td className="px-4 py-3.5">{dayLabel(rule.escalationAfterHours)}</td>
                  <td className="px-4 py-3.5">{appliesToLabel[rule.route]}</td>
                  <td className="px-4 py-3.5"><span className={cn("inline-flex rounded-full px-2.5 py-1 text-[10px] font-bold", rowStatus === "active" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>{rowStatus === "active" ? "启用" : "停用"}</span></td>
                  <td className="px-4 py-3.5">
                    {data.permissions.configure === true && <div className="flex items-center justify-end gap-1">
                      <button ref={(node) => { if (node) ruleEditTriggerRefs.current.set(rule.id, node); else ruleEditTriggerRefs.current.delete(rule.id); }} type="button" aria-label="编辑规则" onClick={() => editDirectoryRule(rule, "direct-edit")} className="flex size-7 items-center justify-center rounded-lg text-[#7d8797] transition hover:bg-slate-100 hover:text-[#273247]"><Pencil className="size-3.5" /></button>
                      <div className="relative" data-sla-rule-menu={rule.id}>
                        <button ref={(node) => { if (node) ruleMenuTriggerRefs.current.set(rule.id, node); else ruleMenuTriggerRefs.current.delete(rule.id); }} type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded={openRuleMenuId === rule.id} onClick={() => setOpenRuleMenuId((current) => current === rule.id ? null : rule.id)} className="flex size-7 items-center justify-center rounded-lg text-[#7d8797] transition hover:bg-slate-100 hover:text-[#273247]"><MoreHorizontal className="size-4" /></button>
                        {openRuleMenuId === rule.id && <div role="menu" onKeyDown={(event) => handleRuleMenuKeyDown(event, rule.id)} className="absolute right-0 top-8 z-20 w-40 overflow-hidden rounded-xl border border-[#e0e5ec] bg-white py-1.5 shadow-[0_14px_36px_rgba(15,23,42,0.14)]">
                          <button type="button" role="menuitem" onClick={() => editDirectoryRule(rule, "rule-menu")} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[#4f5a6d] transition hover:bg-slate-50"><Pencil className="size-3.5" />编辑规则</button>
                          <button type="button" role="menuitem" onClick={() => void duplicateDirectoryRule(rule)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[#4f5a6d] transition hover:bg-slate-50"><Copy className="size-3.5" />复制</button>
                          <div className="my-1 border-t border-[#edf0f4]" />
                          <button type="button" role="menuitem" disabled={directoryRules.length <= 1} onClick={() => { if (data.permissions.configure !== true) return; setOpenRuleMenuId(null); setPendingRuleDeletion(rule); }} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 className="size-3.5" />删除</button>
                        </div>}
                      </div>
                    </div>}
                  </td>
                </tr>;
              })}
              {loading && !data && <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-[#8b95a5]"><span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在读取版本化 SLA 策略…</span></td></tr>}
              {!loading && !data && <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-[#8b95a5]">SLA 策略尚未成功读取，请处理上方提示后重试。</td></tr>}
              {data && !filteredDirectoryRules.length && <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-[#8b95a5]">{directoryRules.length ? "没有符合当前筛选条件的 SLA 规则。" : "暂无 SLA 规则。添加规则以创建版本化草稿。"}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs text-[#8a94a5]">
          {data ? <span>显示 <b className="text-[#566176]">{filteredDirectoryRules.length}</b> / <b className="text-[#566176]">{directoryRules.length}</b> 条</span> : <span>{loading ? "正在读取权威目录" : "权威目录尚不可用"}</span>}
          <span>{data ? (selectedDraft ? `草稿 v${selectedDraft.version}${hasUnsavedChanges ? " · 有未保存更改" : " · 已保存"}` : data.publishedPolicy ? `已发布 v${data.publishedPolicy.version}` : "暂无已发布策略") : "等待权威 SLA 策略"}</span>
        </div>
      </section>

      {governanceMode && data && <div data-sla-governance><section className="mt-5 overflow-hidden rounded-2xl border border-[#dfe5ed] bg-white shadow-sm">
        <button type="button" aria-expanded={governanceOpen} onClick={() => setGovernanceOpen((current) => !current)} className="flex w-full items-center justify-between gap-5 px-5 py-4 text-left transition hover:bg-[#fbfcfe]"><span><span className="block text-sm font-bold text-[#273247]">策略治理与运行</span><span className="mt-1 block text-xs leading-5 text-[#7d8798]">版本草稿、发布影响、自动检查、当前评估与审计历史。</span></span><ChevronDown className={cn("size-4 shrink-0 text-[#8d97a7] transition", governanceOpen && "rotate-180")} /></button>
      </section>

      {automationError && <div role="alert" className="mt-4 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><AlertTriangle className="mt-0.5 size-4 shrink-0" /><span>{automation ? "自动 SLA 检查状态刷新失败，以下保留上次成功读取的运行数据。" : automationError}</span></div>}

      {governanceOpen && <div id="sla-governance" className="scroll-mt-24">

      <section className="mt-6 overflow-hidden rounded-[22px] border border-[#dfe5ee] bg-white shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
        <div className="grid xl:grid-cols-[minmax(0,1.5fr)_minmax(300px,0.5fr)]">
          <div className="p-6 xl:border-r xl:border-[#edf0f4]">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                <FileClock className="size-5" />
              </span>
              <div>
                <h2 className="text-[17px] font-bold text-[#242b38]">
                  SLA 是什么？
                </h2>
                <p className="mt-1.5 max-w-3xl text-xs leading-6 text-[#6f7a8d]">
                  SLA（服务级别协议）在这里表示：每个采购阶段从哪条真实业务事实开始计时、何时预警、允许多长宽限、最多跟进几次，以及超时后升级给谁。它不是付款条款，也不会直接向供应商发信。
                </p>
              </div>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                [
                  "1",
                  "业务事实启动时钟",
                  "精确阶段事件或 RIHD，缺证据就阻断计时",
                ],
                ["2", "到期前提示风险", "按预警窗口区分正常、即将到期和宽限期"],
                [
                  "3",
                  "AI 生成跟进草稿",
                  "草稿先进入人工审阅，不绕过审批直接发送",
                ],
                ["4", "超限后升级", "达到跟进上限后升级到规则指定的责任角色"],
              ].map(([index, title, detail], position) => (
                <div
                  key={index}
                  className="relative rounded-2xl bg-[#f7f9fc] p-4"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex size-6 items-center justify-center rounded-full bg-[#17233d] text-[10px] font-bold text-white">
                      {index}
                    </span>
                    <span className="text-xs font-bold text-[#344057]">
                      {title}
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-5 text-[#7a8699]">
                    {detail}
                  </p>
                  {position < 3 ? (
                    <ArrowRight className="absolute -right-2.5 top-1/2 hidden size-4 -translate-y-1/2 text-[#b9c2cf] xl:block" />
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          <aside className="bg-[#fbfcfe] p-6">
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#929aa8]">
              当前生效状态
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span
                className={cn(
                  "size-2.5 rounded-full",
                  data?.publishedPolicy ? "bg-emerald-500" : "bg-amber-400",
                )}
              />
              <span className="text-sm font-bold text-[#2f394d]">
                {data?.publishedPolicy
                  ? `已发布 v${data.publishedPolicy.version}`
                  : "尚未发布"}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-[#7b8698]">
              {data?.publishedPolicy
                ? "当前策略会参与真实 PO 评估；自动检查仍只生成待审草稿。"
                : "现有策略只是草稿，所有 SLA 时钟、自动检查和基于 SLA 的沟通继续安全等待。"}
            </p>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <ImpactMini
                label="活跃 PO"
                value={currentImpact?.activePurchaseOrders ?? 0}
              />
              <ImpactMini
                label="计时证据就绪"
                value={currentImpact?.readyToEvaluate ?? 0}
                good
              />
            </div>
            {data?.publishedPolicy &&
              data.permissions.configure &&
              data.permissions.approve && (
                <button
                  ref={retireTriggerRef}
                  type="button"
                  onClick={() => setRetireConfirm(true)}
                  disabled={Boolean(busy)}
                  className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-red-200 bg-white text-xs font-semibold text-red-600 disabled:opacity-50"
                >
                  <ShieldOff className="size-3.5" />
                  退役当前策略
                </button>
              )}
          </aside>
        </div>
      </section>

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {metrics.map((metric) => (
          <SlaMetric key={metric.label} {...metric} />
        ))}
      </section>

      <section className="mt-5 overflow-hidden rounded-[22px] border border-[#e2e6ed] bg-white shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
        <div className="grid gap-0 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
          <div className="p-6 xl:border-r xl:border-[#edf0f4]">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-2.5 rounded-full",
                      automationUnavailable
                        ? "bg-slate-300"
                        : automation?.status === "running"
                        ? "animate-pulse bg-blue-500"
                        : automation?.status === "failed"
                          ? "bg-red-500"
                          : automation?.status === "scheduled"
                            ? "bg-emerald-500"
                            : "bg-amber-400",
                    )}
                  />
                  <h2 className="text-[17px] font-bold text-[#242b38]">
                    自动 SLA 检查
                  </h2>
                  <span className="rounded-full bg-[#f1f4f8] px-2.5 py-1 text-[10px] font-bold text-[#657084]">
                    {automationUnavailable
                      ? "状态不可用"
                      : automation
                      ? automationStatusLabel[automation.status]
                      : "读取中"}
                  </span>
                </div>
                <p className="mt-2 max-w-2xl text-xs leading-5 text-[#7f8897]">
                  后台按已发布策略检查
                  PO，只生成唯一、可审阅的供应商跟进草稿；不会绕过审批，也不会直接发送
                  Email、WhatsApp 或回写 ERP。
                </p>
              </div>
              {data?.permissions.operate && !automationUnavailable && (
                <button
                  type="button"
                  onClick={() => void runAutomation()}
                  aria-busy={busy === "automation"}
                  disabled={
                    Boolean(busy) ||
                    !automation?.policy ||
                    automation.status === "running"
                  }
                  className="flex h-10 shrink-0 items-center gap-2 rounded-xl bg-[#17233d] px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <RefreshCw
                    className={cn(
                      "size-3.5",
                      busy === "automation" && "animate-spin",
                    )}
                  />
                  立即运行自动检查
                </button>
              )}
            </div>
            {automationUnavailable ? (
              <div className="mt-6 rounded-2xl border border-dashed border-[#d8dee7] bg-[#f8fafc] px-4 py-5 text-xs leading-5 text-[#737f91]">
                自动化状态尚未成功读取；本次不显示运行间隔、失败次数或最近结果，以免将未知状态误报为零。
              </div>
            ) : <>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <AutomationFact
                label="运行间隔"
                value={
                  automation?.intervalSeconds
                    ? `${Math.round(automation.intervalSeconds / 60)} 分钟`
                    : "等待策略"
                }
              />
              <AutomationFact
                label="下次检查"
                value={formatDate(automation?.nextRunAt ?? null)}
              />
              <AutomationFact
                label="最近完成"
                value={formatDate(automation?.lastCompletedAt ?? null)}
              />
              <AutomationFact
                label="连续失败"
                value={`${automation?.consecutiveFailures ?? 0} 次`}
                danger={Boolean(automation?.consecutiveFailures)}
              />
            </div>
            <div className="mt-5 rounded-2xl border border-[#e7ebf1] bg-[#f8fafc] px-4 py-3 text-xs text-[#677286]">
              {automation?.lastResult ? (
                <>
                  最近结果：检查{" "}
                  <strong className="text-[#263247]">
                    {automation.lastResult.examined ?? 0}
                  </strong>{" "}
                  张，创建{" "}
                  <strong className="text-[#263247]">
                    {automation.lastResult.created ?? 0}
                  </strong>{" "}
                  份草稿，缺少真实收件人跳过{" "}
                  <strong className="text-[#263247]">
                    {automation.lastResult.skippedWithoutRecipient ?? 0}
                  </strong>{" "}
                  张。
                </>
              ) : automation?.lastError ? (
                <span className="text-red-600">{automation.lastError}</span>
              ) : (
                <>
                  {automation?.policy
                    ? "尚无已完成的自动检查。worker 会在租约到期后安全接管，不重复创建同一触发条件的草稿。"
                    : "正式 SLA 策略尚未发布，自动检查保持安全等待，不生成草稿。"}
                </>
              )}
            </div>
            </>}
          </div>
          <div className="border-t border-[#edf0f4] p-6 xl:border-t-0">
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#979eaa]">
              最近运行记录
            </div>
            <div className="mt-4 space-y-4">
              {automationUnavailable ? (
                <div className="text-xs leading-5 text-[#9aa1ad]">
                  运行记录尚未成功读取。
                </div>
              ) : <>
              {automation?.runs.slice(0, 4).map((run) => (
                <div key={run.id} className="flex gap-3">
                  <span
                    className={cn(
                      "mt-1.5 size-2 shrink-0 rounded-full",
                      run.status === "completed"
                        ? "bg-emerald-500"
                        : run.status === "running"
                          ? "animate-pulse bg-blue-500"
                          : run.status === "abandoned"
                            ? "bg-amber-500"
                            : "bg-red-500",
                    )}
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[#4e596b]">
                      {run.status === "completed"
                        ? `已检查 ${run.result?.examined ?? 0} 张 PO`
                        : run.status === "running"
                          ? "检查进行中"
                          : run.status === "abandoned"
                            ? "过期租约已被接管"
                            : "运行失败"}
                    </div>
                    <div className="mt-1 text-[10px] text-[#99a1ae]">
                      {formatDate(run.startedAt)} · {run.workerId}
                    </div>
                    {run.error && (
                      <div className="mt-1 truncate text-[10px] text-red-500">
                        {run.error}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {!automation?.runs.length && (
                <div className="text-xs leading-5 text-[#9aa1ad]">
                  暂无持久化运行记录。
                </div>
              )}
              </>}
            </div>
          </div>
        </div>
      </section>

      {!data?.publishedPolicy ? (
        !selectedDraft && (
          <section className="mt-5 flex min-h-[260px] flex-col items-center justify-center rounded-[22px] border border-dashed border-[#d8dde6] bg-white px-6 text-center">
            <FileClock className="size-10 text-[#bac1cc]" />
            <h2 className="mt-4 text-lg font-bold text-[#293348]">
              {retiredPolicies.length ? "当前没有生效或草稿策略" : "尚未创建 SLA 策略"}
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[#7d8695]">
              {retiredPolicies.length
                ? "历史策略均已退役，不再参与 SLA 评估或自动检查；可在下方只读历史中核对版本与退役记录。"
                : "创建建议草稿后再按真实路线、供应商和内部职责复核。草稿不会自动生效，也不会触发供应商沟通。"}
            </p>
            {data?.permissions.configure && (
              <button
                type="button"
                onClick={() => void createDraft()}
                aria-busy={busy === "create"}
                className="mt-5 flex h-10 items-center gap-2 rounded-xl bg-[#2563eb] px-5 text-xs font-semibold text-white"
              >
                <Plus className="size-4" />
                创建 V1 建议草稿
              </button>
            )}
          </section>
        )
      ) : (
        <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.7fr)]">
          <div className="overflow-hidden rounded-[22px] border border-[#e2e6ed] bg-white shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
            <div className="flex flex-col justify-between gap-3 border-b border-[#edf0f4] px-6 py-5 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-[17px] font-bold text-[#242b38]">
                    {data.publishedPolicy.name}
                  </h2>
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-700">
                    已发布 · v{data.publishedPolicy.version}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[#8a92a1]">
                  {data.publishedPolicy.description || "未填写策略说明"}
                </p>
              </div>
              {data.permissions.operate && (
                <button
                  type="button"
                  onClick={() => void evaluate()}
                  aria-busy={busy === "evaluate"}
                  disabled={Boolean(busy)}
                  className="flex h-9 items-center gap-2 rounded-xl bg-[#17233d] px-4 text-xs font-semibold text-white"
                >
                  <RefreshCw
                    className={cn(
                      "size-3.5",
                      busy === "evaluate" && "animate-spin",
                    )}
                  />
                  立即评估活跃 PO
                </button>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-left">
                <thead>
                  <tr className="bg-[#fafbfc] text-[10px] font-semibold uppercase tracking-[0.08em] text-[#929aa7]">
                    <th className="px-6 py-4">规则</th>
                    <th className="px-4 py-4">路线 / 风险</th>
                    <th className="px-4 py-4">阶段</th>
                    <th className="px-4 py-4">期限 / 日历</th>
                    <th className="px-4 py-4">预警 / 宽限</th>
                    <th className="px-4 py-4">跟进</th>
                    <th className="px-4 py-4">通道</th>
                    <th className="px-4 py-4">升级角色</th>
                  </tr>
                </thead>
                <tbody>
                  {data.publishedPolicy.rules.map((rule) => (
                    <tr
                      key={rule.id}
                      className="border-t border-[#edf0f4] text-xs text-[#5e6879]"
                    >
                      <td className="px-6 py-4">
                        <div className="font-bold text-[#2b3548]">
                          {rule.name}
                        </div>
                        <div className="mt-1 text-[10px] text-[#9aa1ad]">
                          {rule.enabled
                            ? categoryLabel[rule.messageCategory]
                            : "已停用"}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        {routeLabel[rule.route]}
                        <div className="mt-1 text-[10px] text-[#9aa1ad]">
                          {riskLabel[rule.risk]}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span className="rounded-full bg-blue-50 px-2.5 py-1 font-semibold text-blue-700">
                          {stageLabel[rule.stage]}
                        </span>
                      </td>
                      <td className="px-4 py-4">{offsetLabel(rule)}</td>
                      <td className="px-4 py-4">
                        提前 {rule.warningHours}h
                        <div className="mt-1 text-[10px] text-[#9aa1ad]">
                          宽限 {rule.graceHours}h
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        每 {rule.followupIntervalHours}h
                        <div className="mt-1 text-[10px] text-[#9aa1ad]">
                          最多 {rule.maxFollowups} 次
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">
                          {communicationChannelLabel[rule.communicationChannel]}
                        </span>
                      </td>
                      <td className="px-4 py-4">{rule.escalationRole}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <aside className="rounded-[22px] border border-[#e2e6ed] bg-white p-6 shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
            <h2 className="text-[17px] font-bold text-[#242b38]">发布信息</h2>
            <div className="mt-5 space-y-4">
              <Fact
                label="策略版本"
                value={`v${data.publishedPolicy.version}`}
              />
              <Fact
                label="发布人"
                value={data.publishedPolicy.publishedBy ?? "—"}
              />
              <Fact
                label="发布时间"
                value={formatDate(data.publishedPolicy.publishedAt)}
              />
              <Fact
                label="活跃评估"
                value={`${data.evaluations.total} 张 PO`}
              />
              <Fact
                label="缺少证据 / 未匹配"
                value={`${unmatched} 张`}
                tone={unmatched ? "warning" : undefined}
              />
            </div>
            <div className="mt-6 border-t border-[#edf0f4] pt-5">
              <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#979eaa]">
                最近策略活动
              </div>
              <div className="mt-4 space-y-4">
                {data.events.slice(0, 5).map((event, index) => (
                  <div
                    key={`${event.policyId}:${event.createdAt}:${index}`}
                    className="flex gap-3"
                  >
                    <span className="mt-1.5 size-2 shrink-0 rounded-full bg-blue-500" />
                    <div>
                      <div className="text-xs font-medium text-[#505b6e]">
                        {event.action === "published"
                          ? "策略已发布"
                          : event.action === "retired_by_publish"
                            ? "旧版本已退役"
                            : event.action === "draft_updated"
                              ? "草稿已保存"
                              : "创建策略草稿"}
                      </div>
                      <div className="mt-1 text-[10px] text-[#9aa1ad]">
                        {formatDate(event.createdAt)} · {event.actorId}
                      </div>
                    </div>
                  </div>
                ))}
                {!data.events.length && (
                  <div className="text-xs text-[#9aa1ad]">暂无策略活动</div>
                )}
              </div>
            </div>
          </aside>
        </section>
      )}

      {retiredPolicies.length > 0 && (
        <section data-sla-retired-history className="mt-5 overflow-hidden rounded-[22px] border border-[#e2e6ed] bg-white shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
          <div className="border-b border-[#edf0f4] px-6 py-5">
            <h2 className="text-[17px] font-bold text-[#242b38]">历史策略</h2>
            <p className="mt-1 text-xs leading-5 text-[#7d8798]">
              退役策略为只读审计事实，不参与当前评估、自动检查或外部沟通。
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead>
                <tr className="bg-[#fafbfc] text-[10px] font-semibold uppercase tracking-[0.08em] text-[#929aa7]">
                  <th className="px-6 py-4">策略</th>
                  <th className="px-4 py-4">版本</th>
                  <th className="px-4 py-4">状态</th>
                  <th className="px-4 py-4">最后更新</th>
                  <th className="px-4 py-4">操作人</th>
                </tr>
              </thead>
              <tbody>
                {retiredPolicies.map((policy) => {
                  const retirementEvent = data?.events.find((event) =>
                    event.policyId === policy.id &&
                    (event.action === "retired" || event.action === "retired_by_publish"));
                  return (
                    <tr key={policy.id} className="border-t border-[#edf0f4] text-xs text-[#5e6879]">
                      <td className="px-6 py-4">
                        <div data-preserve-language className="font-bold text-[#2b3548]">{policy.name}</div>
                        <div data-preserve-language className="mt-1 max-w-[420px] truncate text-[10px] text-[#9aa1ad]">
                          {policy.description || "—"}
                        </div>
                      </td>
                      <td className="px-4 py-4 font-semibold text-[#344057]">v{policy.version}</td>
                      <td className="px-4 py-4">
                        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600">已退役</span>
                      </td>
                      <td className="px-4 py-4">{formatDate(retirementEvent?.createdAt ?? policy.updatedAt)}</td>
                      <td data-preserve-language className="px-4 py-4">{retirementEvent?.actorId ?? policy.updatedBy}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {selectedDraft && (
        <section className="mt-5 overflow-hidden rounded-[22px] border border-blue-200 bg-white shadow-[0_3px_16px_rgba(37,99,235,0.06)]">
          <div className="flex flex-col justify-between gap-4 border-b border-blue-100 bg-blue-50/40 px-6 py-5 xl:flex-row xl:items-center">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-[17px] font-bold text-[#253149]">
                  策略草稿
                </h2>
                <span className="rounded-full bg-blue-100 px-2.5 py-1 text-[10px] font-bold text-blue-700">
                  v{selectedDraft.version} · 未发布
                </span>
                {hasUnsavedChanges && (
                  <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[10px] font-bold text-amber-700">
                    有未保存变更
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-[#728099]">
                修改仅保存在草稿中；发布会退役当前正式策略并重新评估活跃 PO。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {data!.draftPolicies.length > 1 && (
                <select
                  value={selectedDraft.id}
                  onChange={(event) => setSelectedDraftId(event.target.value)}
                  className="h-10 rounded-xl border border-[#dbe2ec] bg-white px-3 text-xs text-[#526079]"
                >
                  {data!.draftPolicies.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {policy.name} · v{policy.version}
                    </option>
                  ))}
                </select>
              )}
              {data.permissions.configure === true && <button
                type="button"
                onClick={addRule}
                className="flex h-10 items-center gap-2 rounded-xl border border-[#dbe2ec] bg-white px-4 text-xs font-semibold text-[#526079]"
              >
                <Plus className="size-4" />
                添加规则
              </button>}
              {data.permissions.configure === true && <button
                type="button"
                onClick={() => void saveDraft()}
                aria-busy={busy === "save"}
                disabled={
                  Boolean(busy) ||
                  !hasUnsavedChanges
                }
                className="flex h-10 items-center gap-2 rounded-xl border border-[#2563eb] bg-white px-4 text-xs font-semibold text-[#2563eb] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Save className="size-4" />
                {hasUnsavedChanges ? "保存草稿" : "草稿已保存"}
              </button>}
              {data.permissions.configure === true && data.permissions.approve === true && <button
                ref={publishTriggerRef}
                type="button"
                onClick={() => setPublishConfirm(true)}
                disabled={
                  Boolean(busy) ||
                  hasUnsavedChanges
                }
                title={
                  hasUnsavedChanges
                    ? "请先保存草稿，再预览并发布已保存版本"
                    : undefined
                }
                className="flex h-10 items-center gap-2 rounded-xl bg-[#2563eb] px-4 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Send className="size-4" />
                {hasUnsavedChanges ? "先保存再发布" : "发布策略"}
              </button>}
            </div>
          </div>
          <fieldset disabled={data.permissions.configure !== true} className="contents">
          <div className="grid gap-4 border-b border-[#edf0f4] p-6 md:grid-cols-2">
            <label>
              <span className="text-xs font-semibold text-[#5c6678]">
                策略名称
              </span>
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                maxLength={120}
                className="mt-2 h-10 w-full rounded-xl border border-[#dfe4eb] px-3 text-sm outline-none focus:border-blue-500"
              />
            </label>
            <label>
              <span className="text-xs font-semibold text-[#5c6678]">
                策略说明
              </span>
              <input
                value={draftDescription}
                onChange={(event) => setDraftDescription(event.target.value)}
                maxLength={1000}
                className="mt-2 h-10 w-full rounded-xl border border-[#dfe4eb] px-3 text-sm outline-none focus:border-blue-500"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#edf0f4] bg-[#f8fbff] px-6 py-4">
            <div>
              <div className="text-xs font-bold text-[#344057]">
                租户工作日日历
              </div>
              <p className="mt-1 text-[11px] leading-5 text-[#7d899b]">
                选择“租户工作日”的规则会按 {data!.tenantCalendar.timeZone} 中的{" "}
                {data!.tenantCalendar.workingDays
                  .map((day) => weekdayLabel[day] ?? day)
                  .join("、")}
                累计墙上时钟小时，并跳过其他日期。
              </p>
            </div>
            <span className="rounded-full border border-blue-100 bg-white px-3 py-1 text-[10px] font-semibold text-blue-700">
              {data!.tenantCalendar.inheritedDefault
                ? "系统默认日历"
                : `偏好 v${data!.tenantCalendar.preferenceVersion}`}
            </span>
          </div>
          {selectedImpact && (
            <div className="border-b border-[#edf0f4] bg-[#fbfcfe] px-6 py-5">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-[#344057]">
                    发布影响预览
                  </div>
                  <p className="mt-1 text-[11px] text-[#8a95a7]">
                    基于已保存草稿 v{selectedDraft.version} 与当前持久化
                    PO；表格中的未保存编辑不会提前改变预览。
                  </p>
                </div>
                <span className="text-[10px] font-semibold text-[#8490a3]">
                  只读计算，不写入评估
                </span>
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <ImpactFact
                  label="活跃 PO"
                  value={selectedImpact.activePurchaseOrders}
                />
                <ImpactFact
                  label="规则已覆盖"
                  value={selectedImpact.matchedPurchaseOrders}
                  good={
                    selectedImpact.matchedPurchaseOrders ===
                    selectedImpact.activePurchaseOrders
                  }
                />
                <ImpactFact
                  label="计时证据就绪"
                  value={selectedImpact.readyToEvaluate}
                  good={
                    selectedImpact.readyToEvaluate ===
                    selectedImpact.activePurchaseOrders
                  }
                />
                <ImpactFact
                  label="缺少期限证据"
                  value={selectedImpact.missingDeadlineEvidence}
                  warning={selectedImpact.missingDeadlineEvidence > 0}
                />
                <ImpactFact
                  label="未匹配规则"
                  value={selectedImpact.unmatchedPurchaseOrders}
                  warning={selectedImpact.unmatchedPurchaseOrders > 0}
                />
              </div>
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1620px] text-left">
              <thead>
                <tr className="bg-[#fafbfc] text-[10px] font-semibold uppercase tracking-[0.08em] text-[#929aa7]">
                  <th className="px-4 py-3">启用 / 名称</th>
                  <th className="px-3 py-3">路线</th>
                  <th className="px-3 py-3">阶段</th>
                  <th className="px-3 py-3">风险</th>
                  <th className="px-3 py-3">期限基准</th>
                  <th className="px-3 py-3">计时日历</th>
                  <th className="px-3 py-3">偏移 h</th>
                  <th className="px-3 py-3">预警 h</th>
                  <th className="px-3 py-3">宽限 h</th>
                  <th className="px-3 py-3">跟进间隔 h</th>
                  <th className="px-3 py-3">最多次数</th>
                  <th className="px-3 py-3">升级角色</th>
                  <th className="px-3 py-3">沟通通道</th>
                  <th className="px-3 py-3">沟通类型</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {draftRules.map((rule, index) => (
                  <tr key={rule.id} className="border-t border-[#edf0f4]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <input
                          aria-label={`启用 ${rule.name}`}
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={(event) =>
                            updateRule(index, { enabled: event.target.checked })
                          }
                        />
                        <input
                          value={rule.name}
                          onChange={(event) =>
                            updateRule(index, { name: event.target.value })
                          }
                          className="h-9 w-[170px] rounded-lg border border-[#dfe4eb] px-2 text-xs outline-none"
                        />
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={rule.route}
                        onChange={(value) =>
                          updateRule(index, { route: value as Route })
                        }
                        options={routeLabel}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={rule.stage}
                        onChange={(value) =>
                          updateRule(index, { stage: value as Stage })
                        }
                        options={stageLabel}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={rule.risk}
                        onChange={(value) =>
                          updateRule(index, { risk: value as Risk })
                        }
                        options={riskLabel}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={rule.deadlineBasis}
                        onChange={(value) =>
                          updateRule(index, { deadlineBasis: value as Basis })
                        }
                        options={basisLabel}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={rule.calendarMode}
                        onChange={(value) =>
                          updateRule(index, {
                            calendarMode: value as CalendarMode,
                          })
                        }
                        options={calendarModeLabel}
                        wide
                      />
                    </td>
                    <td className="px-3 py-3">
                      <NumberInput
                        value={rule.targetOffsetHours}
                        min={-8760}
                        max={8760}
                        onChange={(value) =>
                          updateRule(index, { targetOffsetHours: value })
                        }
                      />
                    </td>
                    <td className="px-3 py-3">
                      <NumberInput
                        value={rule.warningHours}
                        min={0}
                        max={8760}
                        onChange={(value) =>
                          updateRule(index, { warningHours: value })
                        }
                      />
                    </td>
                    <td className="px-3 py-3">
                      <NumberInput
                        value={rule.graceHours}
                        min={0}
                        max={720}
                        onChange={(value) =>
                          updateRule(index, { graceHours: value })
                        }
                      />
                    </td>
                    <td className="px-3 py-3">
                      <NumberInput
                        value={rule.followupIntervalHours}
                        min={1}
                        max={720}
                        onChange={(value) =>
                          updateRule(index, { followupIntervalHours: value })
                        }
                      />
                    </td>
                    <td className="px-3 py-3">
                      <NumberInput
                        value={rule.maxFollowups}
                        min={0}
                        max={20}
                        onChange={(value) =>
                          updateRule(index, { maxFollowups: Math.round(value) })
                        }
                      />
                    </td>
                    <td className="px-3 py-3">
                      <input
                        value={rule.escalationRole}
                        onChange={(event) =>
                          updateRule(index, {
                            escalationRole: event.target.value,
                          })
                        }
                        className="h-9 w-[110px] rounded-lg border border-[#dfe4eb] px-2 text-xs outline-none"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={rule.communicationChannel}
                        onChange={(value) =>
                          updateRule(index, {
                            communicationChannel: value as CommunicationChannel,
                          })
                        }
                        options={communicationChannelLabel}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={rule.messageCategory}
                        onChange={(value) =>
                          updateRule(index, {
                            messageCategory: value as MessageCategory,
                          })
                        }
                        options={categoryLabel}
                        wide
                      />
                    </td>
                    <td className="px-3 py-3">
                      {data.permissions.configure === true && <button
                        type="button"
                        aria-label={`删除 ${rule.name}`}
                        disabled={draftRules.length <= 1}
                        onClick={() =>
                          setDraftRules((current) =>
                            current.filter(
                              (_, ruleIndex) => ruleIndex !== index,
                            ),
                          )
                        }
                        className="flex size-8 items-center justify-center rounded-lg text-[#9aa1ad] hover:bg-red-50 hover:text-red-500 disabled:opacity-30"
                      >
                        <Trash2 className="size-4" />
                      </button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </fieldset>
        </section>
      )}

      <section className="mt-5 overflow-hidden rounded-[22px] border border-[#e2e6ed] bg-white shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
        <div className="flex items-center justify-between border-b border-[#edf0f4] px-6 py-5">
          <div>
            <h2 className="text-[17px] font-bold text-[#242b38]">
              当前 PO 的 SLA 状态
            </h2>
            <p className="mt-1 text-xs text-[#8a92a1]">
              期限、宽限和下一次跟进均来自当前已发布策略与持久化业务证据。
            </p>
          </div>
          <span className="rounded-full bg-[#f1f4f8] px-3 py-1 text-xs font-semibold text-[#677185]">
            {evaluations.length} 张
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1240px] text-left">
            <thead>
              <tr className="bg-[#fafbfc] text-[10px] font-semibold uppercase tracking-[0.08em] text-[#929aa7]">
                <th className="w-12 px-4 py-4" />
                <th className="px-3 py-4">PO / 供应商</th>
                <th className="px-4 py-4">阶段</th>
                <th className="px-4 py-4">状态</th>
                <th className="px-4 py-4">命中规则</th>
                <th className="px-4 py-4">到期</th>
                <th className="px-4 py-4">宽限至</th>
                <th className="px-4 py-4">下次跟进</th>
                <th className="px-4 py-4">已跟进</th>
                <th className="px-4 py-4">证据来源</th>
              </tr>
            </thead>
            <tbody>
              {evaluations.map((evaluation) => {
                const expanded =
                  expandedEvaluationId === evaluation.purchaseOrderId;
                return (
                  <Fragment key={evaluation.purchaseOrderId}>
                    <tr
                      className={cn(
                        "border-t border-[#edf0f4] text-xs text-[#5e6879]",
                        expanded && "bg-[#fbfcff]",
                      )}
                    >
                      <td className="px-4 py-4">
                        <button
                          type="button"
                          aria-label={`${expanded ? "收起" : "展开"} ${evaluation.purchaseOrderNumber} SLA 证据`}
                          aria-expanded={expanded}
                          onClick={() =>
                            setExpandedEvaluationId(
                              expanded ? null : evaluation.purchaseOrderId,
                            )
                          }
                          className="flex size-8 items-center justify-center rounded-lg border border-[#e2e7ef] bg-white text-[#718096] hover:border-blue-200 hover:text-blue-600"
                        >
                          {expanded ? (
                            <ChevronDown className="size-4" />
                          ) : (
                            <ChevronRight className="size-4" />
                          )}
                        </button>
                      </td>
                      <td className="px-3 py-4">
                        <div className="font-bold text-[#283348]">
                          {evaluation.purchaseOrderNumber}
                        </div>
                        <div className="mt-1 max-w-[180px] truncate text-[10px] text-[#9aa1ad]">
                          {evaluation.supplierName ??
                            evaluation.supplierId ??
                            "供应商未提供"}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        {stageLabel[evaluation.stage]}
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 font-semibold",
                            statusTone[evaluation.status],
                          )}
                        >
                          {statusLabel[evaluation.status]}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        {String(
                          evaluation.evidence["ruleName"] ??
                            evaluation.ruleId ??
                            "未匹配",
                        )}
                      </td>
                      <td className="px-4 py-4">
                        {formatDate(evaluation.dueAt)}
                      </td>
                      <td className="px-4 py-4">
                        {formatDate(evaluation.graceUntil)}
                      </td>
                      <td className="px-4 py-4">
                        {formatDate(evaluation.nextFollowupAt)}
                      </td>
                      <td className="px-4 py-4">
                        {evaluation.followupCount} 次
                      </td>
                      <td className="max-w-[220px] px-4 py-4">
                        <span className="line-clamp-2">
                          {String(
                            evaluation.evidence["basisSource"] ??
                              evaluation.evidence["reason"] ??
                              "—",
                          )}
                        </span>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-t border-[#edf0f4] bg-[#fbfcff]">
                        <td colSpan={10} className="px-6 pb-6 pt-2">
                          <SlaEvidencePanel evaluation={evaluation} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {!evaluations.length && (
                <tr>
                  <td colSpan={10} className="px-6 py-16 text-center">
                    <History className="mx-auto size-7 text-[#c2c8d2]" />
                    <div className="mt-3 text-sm font-semibold text-[#616a7a]">
                      尚无 SLA 评估结果
                    </div>
                    <div className="mt-1 text-xs text-[#969da8]">
                      发布策略后会对所有活跃 PO 建立持久化评估。
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <SlaEvaluationHistory events={data?.evaluationEvents ?? []} />
      </div>}</div>}

      {ruleEditor && (
        <SlaRuleEditorDialog
          editor={ruleEditor}
          busy={busy === "save-rule"}
          writable={data?.permissions.configure === true}
          refreshRequired={refreshRequired}
          refreshing={loading}
          matchConflict={hasDuplicateEnabledMatch(
            ruleEditor.value,
            selectedDraft ? draftRules : data?.publishedPolicy?.rules ?? [],
            ruleEditor.sourceRuleId,
          )}
          resolveReturnFocus={resolveRuleEditorReturnFocus}
          onReload={() => void load()}
          onChange={(patch) => setRuleEditor((current) => current ? { ...current, value: { ...current.value, ...patch } } : current)}
          onClose={() => setRuleEditor(null)}
          onApply={() => void applyRuleEditor()}
        />
      )}
      {pendingRuleDeletion && (
        <SlaConfirmationDialog
          busy={busy === "remove-rule"}
          returnFocus={ruleMenuTriggerRefs.current.get(pendingRuleDeletion.id) ?? null}
          kicker="规则变更确认"
          title={<>删除“<span data-preserve-language>{pendingRuleDeletion.name}</span>”？</>}
          tone="red"
          confirmLabel="删除"
          confirmIcon={Trash2}
          confirmDisabled={directoryRules.length <= 1}
          onClose={() => setPendingRuleDeletion(null)}
          onConfirm={() => void confirmRuleDeletion()}
        >
          {selectedDraft
            ? "该规则只会从浏览器中的未保存草稿移除；点击“保存草稿”后才会持久化。当前已发布策略不会被改写。"
            : "系统会创建一份不含该规则的新版本化草稿。当前已发布策略继续生效，直到新草稿另行获批并发布。"}
        </SlaConfirmationDialog>
      )}
      {publishConfirm && selectedDraft && (
        <SlaConfirmationDialog
          busy={busy === "publish"}
          returnFocus={publishTriggerRef.current}
          kicker="策略发布确认"
          title={<> 发布 <span data-preserve-language>{selectedDraft.name}</span></>}
          tone="amber"
          confirmLabel="确认发布"
          confirmIcon={Send}
          confirmDisabled={hasUnsavedChanges}
          onClose={() => setPublishConfirm(false)}
          onConfirm={() => void publishDraft()}
        >
          发布后会退役当前正式策略，并立即按照已保存草稿 v{selectedDraft.version} 中的{" "}
          {selectedDraft.rules.filter((rule) => rule.enabled).length} 条启用规则重新评估{" "}
          {selectedImpact?.activePurchaseOrders ?? 0} 张活跃 PO。工作日规则会使用当前租户日历并把偏好版本写入评估证据；以后修改租户日历会产生可审计的重算。已有沟通、Outbox 和审计记录不会被删除。
          {selectedImpact && (
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-amber-200 pt-3 text-center text-xs">
              <span><b className="block text-base">{selectedImpact.readyToEvaluate}</b>证据就绪</span>
              <span><b className="block text-base">{selectedImpact.missingDeadlineEvidence}</b>缺少期限证据</span>
              <span><b className="block text-base">{selectedImpact.unmatchedPurchaseOrders}</b>规则未匹配</span>
            </div>
          )}
        </SlaConfirmationDialog>
      )}
      {retireConfirm && data?.publishedPolicy && (
        <SlaConfirmationDialog
          busy={busy === "retire"}
          returnFocus={retireTriggerRef.current}
          kicker="策略退役确认"
          title={<> 退役 <span data-preserve-language>{data.publishedPolicy.name}</span></>}
          tone="red"
          confirmLabel="确认退役"
          confirmIcon={ShieldOff}
          onClose={() => setRetireConfirm(false)}
          onConfirm={() => void retirePolicy()}
        >
          退役后将停止当前 SLA 计时和自动检查，并清除当前评估投影。策略版本、评估事件、沟通记录与审计历史不会删除；重新启用必须创建并发布新的策略草稿。
        </SlaConfirmationDialog>
      )}
    </div>
  );
}

function SlaConfirmationDialog({
  busy,
  returnFocus,
  kicker,
  title,
  tone,
  confirmLabel,
  confirmIcon: ConfirmIcon,
  confirmDisabled = false,
  onClose,
  onConfirm,
  children,
}: {
  busy: boolean;
  returnFocus: HTMLElement | null;
  kicker: string;
  title: ReactNode;
  tone: "amber" | "red";
  confirmLabel: string;
  confirmIcon: typeof ShieldOff;
  confirmDisabled?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(returnFocus);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const returnFocusElement = returnFocusRef.current;
    const frame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busyRef.current) closeRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
      returnFocusElement?.focus();
    };
  }, []);
  const warningTone = tone === "red"
    ? "border-red-200 bg-red-50 text-red-900"
    : "border-amber-200 bg-amber-50 text-amber-900";
  const kickerTone = tone === "red" ? "text-red-600" : "text-amber-600";
  const buttonTone = tone === "red" ? "bg-red-600" : "bg-[#2563eb]";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.currentTarget === event.target && !busyRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sla-confirmation-title"
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )];
          if (!focusable.length) return;
          const first = focusable[0]!;
          const last = focusable[focusable.length - 1]!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        className="w-full max-w-lg rounded-[24px] bg-white p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className={cn("text-[10px] font-bold uppercase tracking-[0.12em]", kickerTone)}>{kicker}</div>
            <h2 id="sla-confirmation-title" className="mt-2 text-xl font-bold text-[#1d273b]">{title}</h2>
          </div>
          <button ref={initialFocusRef} type="button" aria-label="关闭" autoFocus onClick={onClose} disabled={busy} className="flex size-9 items-center justify-center rounded-xl bg-[#f3f5f8] text-[#7d8490] disabled:opacity-50"><X className="size-4" /></button>
        </div>
        <div className={cn("mt-5 rounded-2xl border p-4 text-sm leading-6", warningTone)}>{children}</div>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#626b7a] disabled:opacity-50">取消</button>
          <button type="button" onClick={onConfirm} aria-busy={busy} disabled={busy || confirmDisabled} className={cn("flex h-10 items-center gap-2 rounded-xl px-5 text-xs font-semibold text-white disabled:opacity-50", buttonTone)}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ConfirmIcon className="size-4" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function SlaRuleEditorDialog({
  editor,
  busy,
  writable,
  refreshRequired,
  refreshing,
  matchConflict,
  resolveReturnFocus,
  onChange,
  onClose,
  onReload,
  onApply,
}: {
  editor: RuleEditorState;
  busy: boolean;
  writable: boolean;
  refreshRequired: RefreshRequired | null;
  refreshing: boolean;
  matchConflict: boolean;
  resolveReturnFocus: () => HTMLElement | null;
  onChange: (patch: Partial<Rule>) => void;
  onClose: () => void;
  onReload: () => void;
  onApply: () => void;
}) {
  const rule = editor.value;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const initialFocusRef = useRef<HTMLInputElement | null>(null);
  const resolveReturnFocusRef = useRef(resolveReturnFocus);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  resolveReturnFocusRef.current = resolveReturnFocus;
  closeRef.current = onClose;
  busyRef.current = busy;
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) closeRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", closeOnEscape);
      resolveReturnFocusRef.current()?.focus();
    };
  }, []);
  const minimumEscalation = rule.targetOffsetHours + rule.graceHours;
  const valid =
    rule.name.trim().length > 0 &&
    rule.description.trim().length > 0 &&
    rule.escalationRole.trim().length > 0 &&
    rule.escalationAfterHours >= minimumEscalation &&
    !matchConflict;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm"
      onPointerDown={(event) => {
        if (event.currentTarget === event.target && !busyRef.current) closeRef.current();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="sla-rule-editor-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid && writable && !busy) onApply();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          )];
          if (!focusable.length) return;
          const first = focusable[0]!;
          const last = focusable[focusable.length - 1]!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
        className="flex max-h-[calc(100vh-32px)] w-full max-w-[520px] flex-col overflow-hidden rounded-[22px] bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#e7ebf0] px-6 py-5">
          <div>
            <h2 id="sla-rule-editor-title" className="text-xl font-bold text-[#1d273b]">{editor.mode === "add" ? "添加 SLA 规则" : "编辑 SLA 规则"}</h2>
            <p className="mt-1 text-xs leading-5 text-[#7b8596]">{editor.mode === "add" ? "为采购阶段定义服务级别目标。" : "更新该服务级别目标。"}</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose} disabled={busy} className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#f3f5f8] text-[#7d8490] disabled:opacity-50"><X className="size-4" /></button>
        </div>
        <fieldset disabled={!writable || busy} className="contents">
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {refreshRequired && (
            <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
              <div>{refreshRequirementText(refreshRequired)}</div>
              <button type="button" onClick={onReload} aria-busy={refreshing} disabled={refreshing} className="mt-3 h-8 rounded-lg border border-red-300 bg-white px-3 font-semibold text-red-700 disabled:opacity-50">
                重新读取最新版本
              </button>
            </div>
          )}
          <div className="grid gap-4">
            <label>
              <span className="text-xs font-semibold text-[#566176]">流程 / 阶段 *</span>
              <input ref={initialFocusRef} value={rule.name} onChange={(event) => onChange({ name: event.target.value })} placeholder="例如：采购订单发出 → 供应商响应" maxLength={120} autoFocus className="mt-2 h-10 w-full rounded-xl border border-[#dfe4eb] px-3 text-sm text-[#344057] outline-none transition focus:border-blue-400" />
            </label>
            <label>
              <span className="text-xs font-semibold text-[#566176]">描述 *</span>
              <input value={rule.description} onChange={(event) => onChange({ description: event.target.value })} placeholder="例如：供应商确认采购订单" maxLength={240} className="mt-2 h-10 w-full rounded-xl border border-[#dfe4eb] px-3 text-sm text-[#344057] outline-none transition focus:border-blue-400" />
            </label>
            <div className="grid grid-cols-3 gap-4">
              <RuleDialogNumber label="SLA 目标（天） *" value={dayValue(rule.targetOffsetHours)} min={-365} max={365} step={0.001} onChange={(value) => {
                const targetOffsetHours = value * 24;
                onChange({
                  targetOffsetHours,
                  escalationAfterHours: Math.max(rule.escalationAfterHours, targetOffsetHours + rule.graceHours),
                });
              }} />
              <RuleDialogNumber label="宽限期（天） *" value={dayValue(rule.graceHours)} min={0} max={30} step={0.001} onChange={(value) => {
                const graceHours = value * 24;
                onChange({
                  graceHours,
                  escalationAfterHours: Math.max(rule.escalationAfterHours, rule.targetOffsetHours + graceHours),
                });
              }} />
              <RuleDialogNumber label="升级时间（天） *" value={dayValue(rule.escalationAfterHours)} min={dayValue(minimumEscalation)} max={395} step={0.001} onChange={(value) => onChange({ escalationAfterHours: value * 24 })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <RuleDialogSelect label="适用范围 *" value={rule.route} options={{ all: appliesToLabel.all, local: appliesToLabel.local, import: appliesToLabel.import }} onChange={(value) => onChange({ route: value as Route })} />
              <RuleDialogSelect label="状态 *" value={rule.enabled ? "active" : "inactive"} options={{ active: "启用", inactive: "停用" }} onChange={(value) => onChange({ enabled: value === "active" })} />
            </div>
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="sla-rule-advanced-options"
              onClick={() => setAdvancedOpen((current) => !current)}
              className="flex h-10 items-center justify-between rounded-xl border border-[#dfe4eb] bg-[#f8fafc] px-3 text-xs font-semibold text-[#526079]"
            >
              高级选项
              <ChevronDown className={cn("size-4 transition-transform", advancedOpen && "rotate-180")} />
            </button>
            {advancedOpen && (
              <div id="sla-rule-advanced-options" className="grid gap-4 rounded-2xl border border-[#e4e9f0] bg-[#fbfcfe] p-4 sm:grid-cols-2">
                <RuleDialogSelect
                  label="触发阶段 *"
                  value={rule.stage}
                  options={stageLabel}
                  onChange={(value) => {
                    const stage = value as Stage;
                    const template = v1Template.find((candidate) => candidate.stage === stage);
                    onChange({
                      stage,
                      ...(template ? {
                        deadlineBasis: template.deadlineBasis,
                        messageCategory: template.messageCategory,
                      } : {}),
                    });
                  }}
                />
                <RuleDialogSelect label="风险范围 *" value={rule.risk} options={riskLabel} onChange={(value) => onChange({ risk: value as Risk })} />
                <RuleDialogSelect label="截止基准 *" value={rule.deadlineBasis} options={basisLabel} onChange={(value) => onChange({ deadlineBasis: value as Basis })} />
                <RuleDialogSelect label="日历模式 *" value={rule.calendarMode} options={calendarModeLabel} onChange={(value) => onChange({ calendarMode: value as CalendarMode })} />
                <RuleDialogNumber label="提前预警（小时） *" value={rule.warningHours} min={0} max={8760} step={1} onChange={(value) => onChange({ warningHours: value })} />
                <RuleDialogNumber label="跟进间隔（小时） *" value={rule.followupIntervalHours} min={1} max={720} step={1} onChange={(value) => onChange({ followupIntervalHours: value })} />
                <RuleDialogNumber label="最多跟进次数 *" value={rule.maxFollowups} min={0} max={20} step={1} onChange={(value) => onChange({ maxFollowups: Math.round(value) })} />
                <label>
                  <span className="text-xs font-semibold text-[#566176]">升级角色 *</span>
                  <input value={rule.escalationRole} onChange={(event) => onChange({ escalationRole: event.target.value })} maxLength={100} className="mt-2 h-10 w-full rounded-xl border border-[#dfe4eb] px-3 text-sm text-[#344057] outline-none transition focus:border-blue-400" />
                </label>
                <RuleDialogSelect label="消息类别 *" value={rule.messageCategory} options={categoryLabel} onChange={(value) => onChange({ messageCategory: value as MessageCategory })} />
                <RuleDialogSelect label="沟通渠道 *" value={rule.communicationChannel} options={communicationChannelLabel} onChange={(value) => onChange({ communicationChannel: value as CommunicationChannel })} />
              </div>
            )}
          </div>
          {rule.escalationAfterHours < minimumEscalation && <p role="alert" className="mt-3 text-xs text-red-600">升级时间不得早于 SLA 目标加宽限期。</p>}
          {matchConflict && <p role="alert" className="mt-3 text-xs text-red-600">已存在同一适用范围、触发阶段和风险范围的启用规则。请在高级选项中调整，或先设为停用。</p>}
        </div>
        </fieldset>
        <div className="flex items-center justify-end gap-4 border-t border-[#e7ebf0] bg-[#fbfcfe] px-6 py-4">
          <div className="flex gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-xl border border-[#dfe3ea] bg-white px-4 text-xs font-semibold text-[#626b7a] disabled:opacity-50">取消</button>
            <button type="submit" aria-busy={busy} disabled={busy || !writable || !valid} className="flex h-10 items-center gap-2 rounded-xl bg-[#2563eb] px-5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
              {busy && <Loader2 className="size-4 animate-spin" />}
              {editor.mode === "add" ? "保存规则" : "保存更改"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function RuleDialogSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className="text-xs font-semibold text-[#566176]">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 h-10 w-full rounded-xl border border-[#dfe4eb] bg-white px-3 text-sm text-[#344057] outline-none transition focus:border-blue-400">
        {Object.entries(options).map(([id, optionLabel]) => <option key={id} value={id}>{optionLabel}</option>)}
      </select>
    </label>
  );
}

function RuleDialogNumber({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span className="text-[11px] font-semibold leading-4 text-[#687386]">{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => { const next = Number(event.target.value); if (Number.isFinite(next)) onChange(next); }} className="mt-2 h-9 w-full rounded-lg border border-[#dfe4eb] bg-white px-2 text-xs text-[#344057] outline-none transition focus:border-blue-400" />
    </label>
  );
}

function SlaEvidencePanel({ evaluation }: { evaluation: Evaluation }) {
  const evidence = slaEvaluationEvidenceView({
    policyId: evaluation.policyId,
    policyVersion: evaluation.policyVersion,
    ruleId: evaluation.ruleId,
    stage: evaluation.stage,
    evidence: evaluation.evidence,
  });
  return <SlaEvidenceContent evidence={evidence} />;
}

function SlaEvidenceContent({
  evidence,
}: {
  evidence: ReturnType<typeof slaEvaluationEvidenceView>;
}) {
  const { formatShortDateTime: formatDate } = useProcurementLocale();
  const stage = stageLabel[evidence.stage as Stage] ?? evidence.stage;
  const route = evidence.route
    ? (routeLabel[evidence.route as Route] ?? evidence.route)
    : "—";
  const risk = evidence.risk
    ? (riskLabel[evidence.risk as Risk] ?? evidence.risk)
    : "—";
  const deadlineBasis = evidence.deadlineBasis
    ? (basisLabel[evidence.deadlineBasis as Basis] ?? evidence.deadlineBasis)
    : "—";
  const calendarMode = evidence.calendarMode
    ? (calendarModeLabel[evidence.calendarMode as CalendarMode] ??
      evidence.calendarMode)
    : "—";
  const calendarDetail =
    evidence.calendarMode === "tenant_working_days"
      ? `${evidence.calendarTimeZone ?? "时区未记录"} · ${evidence.calendarWorkingDays.map((day) => weekdayLabel[day] ?? day).join("、") || "工作日未记录"} · ${evidence.calendarInheritedDefault ? "系统默认" : evidence.calendarPreferenceVersion === null ? "版本未记录" : `偏好 v${evidence.calendarPreferenceVersion}`}`
      : "不读取租户日历";
  return (
    <div className="rounded-2xl border border-[#e1e7f0] bg-white p-5 shadow-[0_8px_24px_rgba(32,55,90,0.04)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-blue-600">
            评估证据
          </div>
          <div className="mt-1 text-sm font-bold text-[#283348]">
            本条结果的可追溯依据
          </div>
        </div>
        {evidence.reason && (
          <span className="max-w-xl rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            {evidence.reason}
          </span>
        )}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <EvidenceFact
          label="策略 / 版本"
          value={`${evidence.policyId}${evidence.policyVersion === null ? "" : ` · v${evidence.policyVersion}`}`}
        />
        <EvidenceFact
          label="命中规则"
          value={
            evidence.ruleName
              ? `${evidence.ruleName}${evidence.ruleId ? ` · ${evidence.ruleId}` : ""}`
              : (evidence.ruleId ?? "未命中")
          }
        />
        <EvidenceFact label="阶段" value={stage} />
        <EvidenceFact label="路线 / 风险" value={`${route} / ${risk}`} />
        <EvidenceFact label="期限基准" value={deadlineBasis} />
        <EvidenceFact label="计时日历" value={calendarMode} />
        <EvidenceFact label="日历快照" value={calendarDetail} />
        <EvidenceFact label="基准时间" value={formatDate(evidence.basisAt)} />
        <EvidenceFact label="基准来源" value={evidence.basisSource ?? "—"} />
        <EvidenceFact
          label="阶段进入事件"
          value={
            evidence.stageEntryEvent
              ? `${evidence.stageEntryEvent.eventType} · ${formatDate(evidence.stageEntryEvent.occurredAt)}`
              : "无可验证的精确事件"
          }
        />
      </div>
      {evidence.stageEntryEvent && (
        <div className="mt-4 rounded-xl border border-[#e7ebf1] bg-[#f8fafc] px-4 py-3 text-[11px] leading-5 text-[#687386]">
          <span className="font-bold text-[#39465b]">事件证据：</span>
          {evidence.stageEntryEvent.eventId} ·{" "}
          {evidence.stageEntryEvent.sourceKind} /{" "}
          {evidence.stageEntryEvent.sourceId}
        </div>
      )}
      <div className="mt-4 border-t border-[#edf0f4] pt-4">
        <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#8e97a6]">
          风险因子
        </div>
        {evidence.riskFactors.length ? (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {evidence.riskFactors.map((factor) => (
              <div
                key={`${factor.code}:${factor.evidence}`}
                className="rounded-xl border border-[#e6eaf0] px-3 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-bold text-[#354156]">
                    {factor.label}
                  </span>
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                    {factor.score} 分
                  </span>
                </div>
                <div className="mt-1 text-[11px] leading-5 text-[#7b8595]">
                  {factor.evidence}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 text-xs text-[#98a0ad]">
            当前评估没有持久化风险因子。
          </div>
        )}
      </div>
    </div>
  );
}

function SlaEvaluationHistory({ events }: { events: EvaluationEvent[] }) {
  return (
    <section className="mt-5 overflow-hidden rounded-[22px] border border-[#e2e6ed] bg-white shadow-[0_2px_12px_rgba(20,31,48,0.025)]">
      <div className="flex items-center justify-between border-b border-[#edf0f4] px-6 py-5">
        <div>
          <h2 className="text-[17px] font-bold text-[#242b38]">SLA 评估历史</h2>
          <p className="mt-1 text-xs text-[#8a92a1]">
            来自 SQLite 的不可变评估事件，按发生时间倒序展示，最多 100 条。
          </p>
        </div>
        <span className="rounded-full bg-[#f1f4f8] px-3 py-1 text-xs font-semibold text-[#677185]">
          {events.length} 条
        </span>
      </div>
      {events.length ? (
        <div className="divide-y divide-[#edf0f4]">
          {events.map((event) => (
            <SlaEvaluationHistoryItem key={event.id} event={event} />
          ))}
        </div>
      ) : (
        <div className="px-6 py-14 text-center">
          <FileClock className="mx-auto size-8 text-[#c3c9d2]" />
          <div className="mt-3 text-sm font-semibold text-[#606a7a]">
            尚无持久化评估历史
          </div>
          <div className="mt-1 text-xs leading-5 text-[#969da8]">
            只有在正式策略发布并对真实 PO 产生或改变评估后，这里才会出现记录。
          </div>
        </div>
      )}
    </section>
  );
}

function SlaEvaluationHistoryItem({ event }: { event: EvaluationEvent }) {
  const { formatShortDateTime: formatDate } = useProcurementLocale();
  const detail = recordValue(event.detail) ?? {};
  const evidenceRecord = recordValue(detail["evidence"]) ?? {};
  const currentStatus = evaluationStatusValue(detail["status"]);
  const previousStatus = evaluationStatusValue(detail["previousStatus"]);
  const policyVersion = finiteNumber(evidenceRecord["slaPolicyVersion"]);
  const evidence = slaEvaluationEvidenceView({
    policyId: event.policyId,
    policyVersion,
    ruleId: event.ruleId,
    stage: stringValue(evidenceRecord["stage"]) ?? "未记录阶段",
    evidence: evidenceRecord,
  });
  return (
    <div className="px-6 py-5">
      <div className="flex gap-4">
        <span
          className={cn(
            "mt-1.5 size-2.5 shrink-0 rounded-full",
            currentStatus === "breached" || currentStatus === "escalated"
              ? "bg-red-500"
              : currentStatus === "in_grace" || currentStatus === "due_soon"
                ? "bg-amber-500"
                : "bg-blue-500",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-[#2c374b]">
                {event.purchaseOrderId}
              </span>
              <span className="rounded-full bg-[#f1f4f8] px-2.5 py-1 text-[10px] font-semibold text-[#697487]">
                {event.action === "evaluation_created"
                  ? "建立评估"
                  : event.action === "evaluation_changed"
                    ? "评估变更"
                    : event.action}
              </span>
              {currentStatus && (
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[10px] font-semibold",
                    statusTone[currentStatus],
                  )}
                >
                  {previousStatus ? `${statusLabel[previousStatus]} → ` : ""}
                  {statusLabel[currentStatus]}
                </span>
              )}
            </div>
            <time className="text-[11px] text-[#9199a6]">
              {formatDate(event.createdAt)}
            </time>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-[#7b8595]">
            <span>
              策略 {event.policyId}
              {policyVersion === null ? "" : ` · v${policyVersion}`}
            </span>
            <span>规则 {event.ruleId ?? "未命中"}</span>
            {stringValue(detail["dueAt"]) && (
              <span>到期 {formatDate(stringValue(detail["dueAt"]))}</span>
            )}
          </div>
          <details className="mt-3 rounded-xl border border-[#e6eaf0] bg-[#fbfcfe] px-4 py-3">
            <summary className="cursor-pointer text-xs font-semibold text-[#536177]">
              查看本次评估的证据快照
            </summary>
            <div className="mt-3">
              <SlaEvidenceContent evidence={evidence} />
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function EvidenceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[#e7ebf1] bg-[#fbfcfe] px-3 py-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.07em] text-[#929aa8]">
        {label}
      </div>
      <div className="mt-1.5 break-words text-xs font-semibold leading-5 text-[#3b4659]">
        {value}
      </div>
    </div>
  );
}
function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function evaluationStatusValue(value: unknown): EvaluationStatus | null {
  return typeof value === "string" && value in statusLabel
    ? (value as EvaluationStatus)
    : null;
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warning";
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[#edf0f4] pb-3 last:border-0 last:pb-0">
      <span className="text-xs text-[#7d8695]">{label}</span>
      <span
        className={cn(
          "text-right text-xs font-bold text-[#313b4e]",
          tone === "warning" && "text-amber-600",
        )}
      >
        {value}
      </span>
    </div>
  );
}
function SlaMetric({
  icon: Icon,
  label,
  value,
  detail,
  tone,
}: {
  icon: typeof ShieldCheck;
  label: string;
  value: number;
  detail: string;
  tone: "blue" | "green" | "amber" | "red";
}) {
  const iconTone = {
    blue: "bg-blue-50 text-blue-600",
    green: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    red: "bg-red-50 text-red-600",
  }[tone];
  const cardTone =
    tone === "red" && value > 0
      ? "border-red-200 bg-gradient-to-br from-red-50 to-white"
      : "border-slate-200 bg-white";
  return (
    <div
      className={cn(
        "min-h-[172px] rounded-[22px] border p-5 shadow-[0_2px_10px_rgba(15,23,42,0.03)]",
        cardTone,
      )}
    >
      <div
        className={cn(
          "flex size-11 items-center justify-center rounded-full",
          iconTone,
        )}
      >
        <Icon className="size-5" />
      </div>
      <div className="mt-4 text-[34px] font-bold leading-none tracking-[-0.04em] text-[#111827]">
        {value}
      </div>
      <div className="mt-2 text-sm font-semibold text-[#27344a]">{label}</div>
      <div className="mt-1 truncate text-xs text-slate-400">{detail}</div>
    </div>
  );
}
function AutomationFact({
  label,
  value,
  danger = false,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-[#929aa8]">
        {label}
      </div>
      <div
        className={cn(
          "mt-1.5 text-sm font-bold text-[#2f394c]",
          danger && "text-red-600",
        )}
      >
        {value}
      </div>
    </div>
  );
}
function ImpactMini({
  label,
  value,
  good = false,
}: {
  label: string;
  value: number;
  good?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[#e4e9f0] bg-white px-3 py-3">
      <div
        className={cn(
          "text-xl font-bold text-[#273248]",
          good && value > 0 && "text-emerald-600",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[10px] text-[#8a95a7]">{label}</div>
    </div>
  );
}
function ImpactFact({
  label,
  value,
  good = false,
  warning = false,
}: {
  label: string;
  value: number;
  good?: boolean;
  warning?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-white px-3 py-3",
        warning
          ? "border-amber-200"
          : good
            ? "border-emerald-200"
            : "border-[#e4e9f0]",
      )}
    >
      <div
        className={cn(
          "text-xl font-bold text-[#273248]",
          warning && "text-amber-600",
          good && "text-emerald-600",
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[10px] text-[#8a95a7]">{label}</div>
    </div>
  );
}
function Select({
  value,
  onChange,
  options,
  wide = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Record<string, string>;
  wide?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-9 rounded-lg border border-[#dfe4eb] bg-white px-2 text-xs outline-none",
        wide ? "w-[150px]" : "w-[115px]",
      )}
    >
      {Object.entries(options).map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  );
}
function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(event) => onChange(Number(event.target.value))}
      className="h-9 w-[78px] rounded-lg border border-[#dfe4eb] px-2 text-xs outline-none"
    />
  );
}
