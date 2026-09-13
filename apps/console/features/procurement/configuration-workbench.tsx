"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Bot,
  Building2,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ClipboardCheck,
  LockKeyhole,
  MailCheck,
  Send,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { ProcurementChannelConnectionsPanel } from "@/features/procurement/channel-connections-panel";
import { HermesPlatformsPanel } from "@/features/procurement/hermes-platforms-panel";
import { MessagingGatewayPanel } from "@/features/procurement/messaging-gateway-panel";
import type {
  ChannelConnectionSummary,
  ConfigurationConnectionId,
  ConfigurationAutoSendGateId,
  ConfigurationAutoSendSummary,
} from "@/features/procurement/channel-connections-view-model";
import { ProcurementCommunicationIdentityPanel } from "@/features/procurement/communication-identity-panel";
import { ProcurementDeploymentProfilePanel } from "@/features/procurement/deployment-profile-panel";
import { ProcurementTenantPreferencesPanel, type ProcurementPreferencesSaveState } from "@/features/procurement/tenant-preferences-panel";
import { ProcurementV1ReadinessPanel } from "@/features/procurement/v1-readiness-panel";
import { READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS, READYWORK_PAGE_TITLE_CLASS } from "@/features/procurement/visual-tokens";
import { cn } from "@/lib/utils";
import { useUiLanguage } from "@/features/localization/ui-language";

type ConfigurationTarget = "sla" | "local-procurement" | "po-intake" | "ai-records";
const configurationSections = [
  { id: "general-settings", label: "常规设置", Icon: Settings2 },
  { id: "agent-setup", label: "智能体设置", Icon: Bot },
  { id: "business-systems", label: "业务系统", Icon: Building2 },
  { id: "auto-send-follow-ups", label: "自动发送", Icon: Send },
  { id: "advanced-governance", label: "高级治理", Icon: ShieldCheck },
] as const;

const AUTO_SEND_GATE_IDS: ConfigurationAutoSendGateId[] = [
  "permission",
  "published_profile",
  "communication_identity",
  "allowlists",
  "supplier_target",
  "connector",
  "kill_switch",
];

export function ProcurementConfigurationWorkbench({
  mode,
  governanceMode,
  publicDemo = false,
  connections,
  autoSend,
  connectionsManageable,
  loading,
  error,
  connectionSourceLoaded = true,
  onOpenConnector,
  onDisconnectConnector,
  onNavigate,
  children,
}: {
  mode: "settings" | "tools";
  governanceMode?: boolean;
  publicDemo?: boolean;
  connections: readonly ChannelConnectionSummary[];
  autoSend: ConfigurationAutoSendSummary | null;
  connectionsManageable: boolean;
  loading: boolean;
  error?: string | null;
  connectionSourceLoaded?: boolean;
  onOpenConnector: (connectorId: Exclude<ConfigurationConnectionId, "wechat">) => void;
  onDisconnectConnector: (connectorId: Exclude<ConfigurationConnectionId, "wechat">) => void;
  onNavigate: (target: ConfigurationTarget) => void;
  children: ReactNode;
}) {
  const { language } = useUiLanguage();
  const [urlGovernanceMode] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("configurationGovernance") === "1");
  const [runtimeGovernanceMode, setRuntimeGovernanceMode] = useState(false);
  const showGovernance = Boolean(governanceMode || urlGovernanceMode || runtimeGovernanceMode);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [moreChannelsOpen, setMoreChannelsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [preferencesSaveState, setPreferencesSaveState] = useState<ProcurementPreferencesSaveState>({ disabled: true, saving: false });
  const [pendingConnector, setPendingConnector] = useState<Exclude<ConfigurationConnectionId, "wechat"> | null>(null);
  const advancedRef = useRef<HTMLDivElement>(null);
  const advancedTriggerRef = useRef<HTMLButtonElement>(null);
  const advancedReturnFocusRef = useRef<HTMLElement | null>(null);
  const managedConnections = connections.filter((item) => item.id !== "wechat");
  const verifiedConnections = managedConnections.filter((item) => item.externalVerified && item.runtimeHealthy).length;
  const connectionReady = (id: "email" | "deepseek") => {
    const connection = connections.find((item) => item.id === id);
    return Boolean(connectionSourceLoaded && !error && connection?.status === "installed" && connection.runtimeHealthy && connection.credentialReady && connection.externalVerified && connection.credentialCount > 0);
  };
  const emailReady = connectionReady("email");
  const aiReady = connectionReady("deepseek");
  const setupReady = emailReady && aiReady;
  const missingSetupCount = Number(!emailReady) + Number(!aiReady);
  const autoSendGates = autoSend ? AUTO_SEND_GATE_IDS.map((id) => autoSend.gates.find((item) => item.id === id) ?? {
    id,
    label: id,
    status: "blocked" as const,
    detail: "服务端未返回该门禁状态。",
  }) : [];

  useEffect(() => {
    if (!advancedOpen || !pendingConnector) return;
    const connectorId = pendingConnector;
    setPendingConnector(null);
    const frame = window.requestAnimationFrame(() => onOpenConnector(connectorId));
    return () => window.cancelAnimationFrame(frame);
  }, [advancedOpen, onOpenConnector, pendingConnector]);

  useEffect(() => {
    if (!advancedOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setAdvancedOpen(false);
      window.requestAnimationFrame(() => advancedReturnFocusRef.current?.focus());
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [advancedOpen]);

  const administrationBoundary = loading ? (
    <div className="rounded-2xl border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">正在核验管理员控制面权限…</div>
  ) : error ? (
    <div role="alert" aria-label="管理员治理边界" className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-xs leading-5 text-amber-800">无法确认管理员控制面权限，因此未加载连接器目录、文档运维明细或安全事故证据：<span data-preserve-language>{error}</span></div>
  ) : (
    <section aria-label="管理员治理边界" className="overflow-hidden rounded-2xl border border-blue-100 bg-white shadow-sm">
      <div className="flex flex-col gap-4 border-b border-blue-100 bg-blue-50/65 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white text-blue-600 shadow-sm"><LockKeyhole className="size-4" /></span><span><span className="block text-sm font-bold text-[#273247]">管理员治理控制面</span><span className="mt-1 block text-xs leading-5 text-[#687386]">采购经理可读取上方同一租户的真实发布门槛；连接器安装、文档运维明细和安全事故处置仅由管理员执行。</span></span></div>
        <span className="inline-flex h-7 shrink-0 items-center rounded-full border border-blue-200 bg-white px-3 text-[10px] font-bold text-blue-700">只读边界</span>
      </div>
      <div className="grid gap-px bg-[#edf0f4] sm:grid-cols-3">
        <div className="bg-white px-5 py-4"><div className="text-[10px] uppercase tracking-[0.12em] text-slate-400">真实外部验证</div><div className="mt-1 text-xl font-semibold text-slate-900">{verifiedConnections}/{managedConnections.length || 3}</div><div className="mt-1 text-[11px] text-slate-500">来自脱敏连接摘要</div></div>
        <div className="bg-white px-5 py-4"><div className="text-[10px] uppercase tracking-[0.12em] text-slate-400">凭据状态记录</div><div className="mt-1 text-xl font-semibold text-slate-900">{managedConnections.reduce((total, item) => total + item.credentialCount, 0)}</div><div className="mt-1 text-[11px] text-slate-500">不返回凭据名称、字段或密文</div></div>
        <div className="bg-white px-5 py-4"><div className="text-[10px] uppercase tracking-[0.12em] text-slate-400">管理动作</div><div className="mt-1 text-xl font-semibold text-slate-900">管理员</div><div className="mt-1 text-[11px] text-slate-500">权限不足不会再显示成 0 条记录</div></div>
      </div>
    </section>
  );

  if (publicDemo) {
    const english = language === "en";
    const disabledCapabilities = english
      ? [
          ["Connector and credential configuration is unavailable", "No provider secrets can be entered, read, tested, or changed."],
          ["Uploads and raw exports are disabled", "Only pre-seeded, security-checked synthetic attachments can be viewed."],
          ["External delivery is simulated", "Email, messaging, ERP, webhooks, and MCP produce labeled simulated receipts."],
        ]
      : [
          ["连接器和凭据配置不可用", "无法输入、读取、测试或修改任何供应商密钥。"],
          ["已禁用上传和原始导出", "仅可查看预置且通过安全检查的合成附件。"],
          ["对外发送均为模拟", "邮件、消息、ERP、Webhook 和 MCP 仅产生带标识的模拟回执。"],
        ];
    return <div className="mx-auto -mt-[14.5px] w-full max-w-[1540px] space-y-6">
      <section className={cn("border-b border-[#e8edf4] pb-[26px]", READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS)}>
        <div className="text-[11px] font-medium text-[#8a94a6]">{english ? "Settings / Public demo" : "设置 / 公开演示"}</div>
        <h1 className={cn(READYWORK_PAGE_TITLE_CLASS, "mt-2")}>{english ? "Public demo safety boundary" : "公开演示安全边界"}</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-[#687386]">{english ? "This workspace exposes real product state and interactions while keeping every external system disconnected." : "此工作区展示真实产品状态和交互，但不连接任何外部系统。"}</p>
      </section>
      <section className="overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/60 shadow-sm">
        <div className="flex items-start gap-3 border-b border-amber-200 px-5 py-4"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white text-amber-700 shadow-sm"><LockKeyhole className="size-4" /></span><span><span className="block text-sm font-bold text-amber-950">{english ? "Read-only configuration preview" : "配置只读预览"}</span><span className="mt-1 block text-xs leading-5 text-amber-900/75">{english ? "Server-side denial remains authoritative even if a client is modified." : "即使客户端被修改，服务端仍会强制拒绝这些功能。"}</span></span></div>
        <div className="grid gap-px bg-amber-200/70 md:grid-cols-3">{disabledCapabilities.map(([title, description]) => <div key={title} className="bg-white px-5 py-5"><div className="flex items-center gap-2 text-xs font-bold text-[#273247]"><ShieldCheck className="size-4 text-amber-600" />{title}</div><p className="mt-2 text-[11px] leading-5 text-[#778195]">{description}</p></div>)}</div>
      </section>
    </div>;
  }

  if (mode === "tools") return <div className="space-y-5">{connectionsManageable ? children : administrationBoundary}</div>;

  function openAdvanced(origin?: HTMLElement | null) {
    advancedReturnFocusRef.current = origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setAdvancedOpen(true);
    window.requestAnimationFrame(() => advancedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function openConnector(connectorId: Exclude<ConfigurationConnectionId, "wechat">) {
    advancedReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRuntimeGovernanceMode(true);
    setAdvancedOpen(true);
    setPendingConnector(connectorId);
  }

  return (
    <div className="mx-auto -mt-[14.5px] w-full max-w-[1540px] space-y-6">
      <section className={cn("flex flex-col gap-5 border-b border-[#e8edf4] pb-[26px] xl:flex-row xl:items-start xl:justify-between", READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS)}>
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-[#8a94a6]">设置 <span className="px-1 text-[#c1c7d0]">/</span> <span className="text-[#4b5565]">自动跟单</span></div>
          <h1 className={cn(READYWORK_PAGE_TITLE_CLASS, "mt-2")}>自动跟单设置</h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[#687386]">先完成邮箱和 AI 解析连接，就能自动识别供应商回复并提醒下一步。</p>
        </div>
        {showGovernance ? <div className="flex shrink-0 flex-wrap items-center gap-3">
          <span className="text-[11px] text-[#8a94a6]">各分区独立保存 · 服务端版本控制 · 全程审计</span>
          <button
            type="button"
            onClick={(event) => openAdvanced(event.currentTarget)}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-[#2563eb] px-4 text-xs font-bold text-white shadow-sm shadow-blue-200 transition hover:bg-[#1d4ed8]"
          >
            <ClipboardCheck className="size-4" />检查 V1 就绪状态
          </button>
        </div> : null}
      </section>

      <section data-testid="configuration-readiness-summary" className={cn("overflow-hidden rounded-[22px] border shadow-sm", setupReady ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50/70")}>
        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-center">
          <div className="min-w-0">
            <div className={cn("flex size-10 items-center justify-center rounded-2xl bg-white shadow-sm", setupReady ? "text-emerald-600" : "text-amber-600")}>{setupReady ? <CheckCircle2 className="size-5" /> : <CircleAlert className="size-5" />}</div>
            <h2 className="mt-4 text-xl font-bold tracking-[-0.025em] text-[#1f2937]">{loading && !connectionSourceLoaded ? "正在检查自动跟单状态" : !connectionSourceLoaded || error ? "暂时无法确认自动跟单状态" : setupReady ? "系统已可开始处理供应商邮件" : `还有 ${missingSetupCount} 项需要完成`}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#667085]">{setupReady ? "邮箱和 AI 解析已就绪。供应商回复到达后，系统会识别交期、数量和发运信息，需要时再提交人工审批。" : "按右侧顺序完成连接，不需要理解消息网关或适配器。"}</p>
            <button type="button" disabled={loading || !connectionSourceLoaded || Boolean(error) || (!setupReady && !connectionsManageable)} onClick={() => { if (setupReady) onNavigate("po-intake"); else openConnector(emailReady ? "deepseek" : "email"); }} className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
              {setupReady ? "查看待核验邮件" : connectionsManageable ? (emailReady ? "完成 AI 解析连接" : "完成邮箱连接") : "联系管理员完成连接"}<ArrowRight className="size-4" />
            </button>
          </div>
          <ol className="space-y-2 rounded-2xl border border-white/80 bg-white/85 p-3 shadow-sm">
            {[["公司邮箱", emailReady], ["AI 解析", aiReady], ["开始自动跟单", setupReady]].map(([label, ready], index) => <li key={String(label)} className="flex items-center gap-3 rounded-xl px-3 py-2.5"><span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold", ready ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500")}>{ready ? "✓" : index + 1}</span><span className="flex-1 text-sm font-semibold text-[#344054]">{label}</span><span className={cn("text-xs font-medium", ready ? "text-emerald-700" : "text-slate-500")}>{ready ? "已就绪" : "待完成"}</span></li>)}
          </ol>
        </div>
      </section>

      {showGovernance && <nav aria-label="配置分区" className="flex min-w-0 gap-1 overflow-x-auto rounded-xl border border-[#e5eaf1] bg-white p-1.5 shadow-sm">
        {configurationSections.map(({ id, label, Icon }) => (
          <button
            key={String(id)}
            type="button"
            onClick={(event) => {
              if (id === "advanced-governance") openAdvanced(event.currentTarget);
              window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
            }}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-xs font-semibold text-[#566176] transition hover:bg-[#f2f6fb] hover:text-[#1e3a5f]"
          >
            <Icon className="size-3.5 text-[#2563eb]" />{label}
          </button>
        ))}
      </nav>}

      <section id="general-settings" className="scroll-mt-24 overflow-hidden rounded-2xl border border-[#e2e7ef] bg-white shadow-sm">
        <div className="flex items-center gap-3">
          <button type="button" aria-expanded={preferencesOpen} aria-controls="tenant-preferences-disclosure" onClick={() => setPreferencesOpen((current) => !current)} className="flex min-w-0 flex-1 items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-[#fbfcfe]">
            <span><span className="block text-sm font-bold text-[#273247]">调整工作日和时区</span><span className="mt-1 block text-xs leading-5 text-[#778195]">已使用推荐默认值；只有业务日历不同时才需要修改。</span></span><ChevronDown className={cn("size-4 shrink-0 text-[#8b95a5] transition", preferencesOpen && "rotate-180")} />
          </button>
          {preferencesOpen ? <button type="submit" form="tenant-preferences-form" disabled={preferencesSaveState.disabled} aria-busy={preferencesSaveState.saving} className="mr-4 inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-[#2563eb] px-4 text-xs font-bold text-white transition hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50"><ClipboardCheck className="size-4" />{preferencesSaveState.saving ? "保存中…" : "保存更改"}</button> : null}
        </div>
        {preferencesOpen ? <div id="tenant-preferences-disclosure" className="border-t border-[#edf0f4] [&>div]:rounded-none [&>div]:border-0 [&>div]:shadow-none">
          <ProcurementTenantPreferencesPanel referenceLayout={!showGovernance} onSaveStateChange={setPreferencesSaveState} />
        </div> : null}
        {showGovernance && <div className="grid gap-px border-t border-[#edf0f4] bg-[#edf0f4] md:grid-cols-3">
          <button type="button" onClick={() => onNavigate("sla")} className="flex min-h-20 items-center justify-between gap-4 bg-white px-5 py-4 text-left transition hover:bg-[#fbfcfe]">
            <span><span className="block text-xs font-bold text-[#273247]">SLA 升级与催交规则</span><span className="mt-1 block text-[11px] leading-5 text-[#7f899a]">此处控制总门禁；规则内容仍在独立 SLA 工作台中版本化发布。</span></span><ArrowRight className="size-4 shrink-0 text-[#9aa3b2]" />
          </button>
          <div className="flex min-h-20 items-center gap-3 bg-white px-5 py-4"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600"><ShieldCheck className="size-4" /></span><span><span className="block text-xs font-bold text-[#273247]">审计时点不改写</span><span className="mt-1 block text-[11px] leading-5 text-[#7f899a]">时区和格式只影响展示。</span></span></div>
          <div className="flex min-h-20 items-center gap-3 bg-white px-5 py-4"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600"><Settings2 className="size-4" /></span><span><span className="block text-xs font-bold text-[#273247]">节假日证据冻结</span><span className="mt-1 block text-[11px] leading-5 text-[#7f899a]">每次 SLA 计算保留国家、年份、日期及 date-holidays 版本。</span></span></div>
        </div>}
      </section>

      <section id="agent-setup" className="scroll-mt-24 space-y-4">
        <div>
          <h2 className="text-base font-bold tracking-[-0.015em] text-[#1e293b]">常用连接</h2>
          <p className="mt-1 text-xs leading-5 text-[#778195]">优先完成日常跟单所需的连接；不常用的渠道暂不打扰。</p>
        </div>
        <ProcurementChannelConnectionsPanel
          connections={connections}
          category="communication"
          manageable={connectionsManageable}
          loading={loading}
          error={error}
          sourceLoaded={connectionSourceLoaded}
          onOpen={openConnector}
          onDisconnect={onDisconnectConnector}
        />
        <div className="pt-1">
          <h3 className="text-sm font-bold text-[#273247]">AI 回复解析</h3>
          <p className="mt-1 text-xs leading-5 text-[#778195]">识别供应商邮件中的交期、数量和发运信息；高风险结果仍需人工审批。</p>
        </div>
        <ProcurementChannelConnectionsPanel
          connections={connections}
          category="ai"
          manageable={connectionsManageable}
          loading={loading}
          error={error}
          sourceLoaded={connectionSourceLoaded}
          onOpen={openConnector}
          onDisconnect={onDisconnectConnector}
        />
        <section aria-label="更多消息渠道" className="overflow-hidden rounded-2xl border border-[#e2e7ef] bg-white shadow-sm">
          <button type="button" aria-expanded={moreChannelsOpen} aria-controls="more-messaging-channels" onClick={() => setMoreChannelsOpen((current) => !current)} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-[#fbfcfe]">
            <span><span className="block text-sm font-bold text-[#273247]">个人微信和其他消息渠道</span><span className="mt-1 block text-xs leading-5 text-[#778195]">个人微信可直接扫码接入；也可按需添加企业微信、钉钉、飞书、Telegram 等渠道。</span></span><ChevronDown className={cn("size-4 shrink-0 text-[#8b95a5] transition", moreChannelsOpen && "rotate-180")} />
          </button>
          {moreChannelsOpen ? <div id="more-messaging-channels" className="border-t border-[#edf0f4] bg-[#f8fafc] p-4"><HermesPlatformsPanel /></div> : null}
        </section>
        <section aria-label="系统诊断入口" className="overflow-hidden rounded-2xl border border-[#e2e7ef] bg-white shadow-sm">
          <button type="button" aria-expanded={diagnosticsOpen} aria-controls="messaging-system-diagnostics" onClick={() => setDiagnosticsOpen((current) => !current)} className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition hover:bg-[#fbfcfe]">
            <span><span className="block text-sm font-bold text-[#273247]">查看系统诊断</span><span className="mt-1 block text-xs leading-5 text-[#778195]">仅在排查收发异常时查看队列、适配器和运行详情。</span></span><ChevronDown className={cn("size-4 shrink-0 text-[#8b95a5] transition", diagnosticsOpen && "rotate-180")} />
          </button>
          {diagnosticsOpen ? <div id="messaging-system-diagnostics" className="border-t border-[#edf0f4] bg-[#f8fafc] p-4"><MessagingGatewayPanel includePlatforms={false} /></div> : null}
        </section>
        {showGovernance && <><div id="communication-identity" className="scroll-mt-24"><ProcurementCommunicationIdentityPanel /></div>
        <button type="button" onClick={() => onNavigate("po-intake")} className="flex w-full items-center justify-between rounded-2xl border border-[#e2e7ef] bg-white p-4 text-left shadow-sm transition hover:border-blue-300">
          <span className="flex min-w-0 items-center gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><MailCheck className="size-4" /></span><span><span className="block text-sm font-bold text-[#273247]">邮箱 PO 待核验</span><span className="mt-1 block text-xs text-[#778195]">查看附件安全扫描、结构化提取和人工核验结果。</span></span></span><ArrowRight className="size-4 shrink-0 text-[#9aa3b2]" />
        </button></>}
      </section>

      {showGovernance && <>
      <section id="business-systems" className="scroll-mt-24 space-y-4">
        <div>
          <h2 className="text-base font-bold tracking-[-0.015em] text-[#1e293b]">业务系统</h2>
          <p className="mt-1 text-xs leading-5 text-[#778195]">ERP/Odoo 是独立的业务系统连接，不与通信通道混合展示或判定。</p>
        </div>
        <ProcurementChannelConnectionsPanel
          connections={connections}
          category="business"
          manageable={connectionsManageable}
          loading={loading}
          error={error}
          sourceLoaded={connectionSourceLoaded}
          onOpen={openConnector}
          onDisconnect={onDisconnectConnector}
        />
      </section>

      <section id="auto-send-follow-ups" className="scroll-mt-24 overflow-hidden rounded-2xl border border-[#dfe5ee] bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-[#edf0f4] px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><span className="flex size-8 items-center justify-center rounded-lg bg-blue-50 text-blue-600"><Send className="size-4" /></span><h2 className="text-base font-bold tracking-[-0.015em] text-[#1e293b]">自动发送跟进</h2></div>
            <p className="mt-2 max-w-3xl text-xs leading-5 text-[#778195]">启用后，命中允许列表且通过全部服务端门禁的消息可绕过邮件草稿人工队列</p>
          </div>
          {connectionSourceLoaded && autoSend ? <div className="flex shrink-0 items-center gap-3">
            <span className={cn("rounded-full px-2.5 py-1 text-[10px] font-bold", autoSend.ready ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700")}>{autoSend.ready ? "全部门禁已就绪" : `${autoSend.blockers.length} 项阻塞`}</span>
            <button
              type="button"
              role="switch"
              aria-label="打开服务器自动发送策略"
              aria-checked={autoSend.enabled === true}
              disabled={!autoSend.ready || loading || Boolean(error)}
              onClick={() => onNavigate("sla")}
              className={cn("relative h-7 w-12 rounded-full transition focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2", autoSend.enabled ? "bg-blue-600" : "bg-slate-300", (!autoSend.ready || loading || error) && "cursor-not-allowed opacity-55")}
            >
              <span className={cn("absolute top-1 size-5 rounded-full bg-white shadow-sm transition", autoSend.enabled ? "left-6" : "left-1")} />
            </button>
          </div> : <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-600">{loading && !connectionSourceLoaded ? "正在读取状态" : "状态不可用"}</span>}
        </div>
        {!connectionSourceLoaded || !autoSend ? <div role={error ? "alert" : "status"} className={cn("px-5 py-5 text-xs leading-5", error ? "bg-red-50 text-red-700" : "bg-slate-50 text-slate-600")}>
          {loading && !connectionSourceLoaded ? "正在读取服务端自动发送门禁…" : <>自动发送门禁状态不可用，未展示任何推测的配置、允许列表或阻断数量。{error ? <> <span data-preserve-language>{error}</span></> : null}</>}
        </div> : <>
        {error && <div role="alert" className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-xs leading-5 text-amber-800">最新自动发送门禁读取失败，正在显示上次成功读取的只读状态；策略入口已停用：<span data-preserve-language>{error}</span></div>}
        <div className="grid gap-px bg-[#edf0f4] lg:grid-cols-[0.78fr_1.22fr]">
          <div className="bg-white p-5">
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">服务器策略</div>
            <dl className="mt-4 space-y-3 text-xs">
              <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">已发布配置</dt><dd data-preserve-language className="font-semibold text-slate-800">{autoSend?.profileId ? `${autoSend.profileId} v${autoSend.profileVersion ?? "—"}` : "未发布"}</dd></div>
              <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">阶段允许列表</dt><dd data-preserve-language className="max-w-[58%] truncate font-semibold text-slate-800">{autoSend?.stageAllowlist.join(", ") || "无"}</dd></div>
              <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">通道允许列表</dt><dd data-preserve-language className="font-semibold text-slate-800">{autoSend?.channelAllowlist.join(", ") || "无"}</dd></div>
              <div className="flex items-center justify-between gap-4"><dt className="text-slate-500">风险允许列表</dt><dd data-preserve-language className="font-semibold text-slate-800">{autoSend?.riskAllowlist.join(", ") || "无"}</dd></div>
            </dl>
            <button type="button" onClick={() => onNavigate("sla")} className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-bold text-blue-600 transition hover:bg-blue-50">打开服务器策略<ArrowRight className="size-3.5" /></button>
          </div>
          <div className="bg-white p-5">
            <div className="mb-3 flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">就绪门禁</span><span className="text-[10px] text-slate-400">来自 API 的只读状态</span></div>
            <div className="grid gap-2 sm:grid-cols-2">
              {autoSendGates.map((gate) => <div key={gate.id} data-auto-send-gate={gate.id} className={cn("flex items-start gap-2 rounded-xl border px-3 py-2.5", gate.status === "ready" ? "border-emerald-100 bg-emerald-50/60" : "border-amber-100 bg-amber-50/60")}>
                {gate.status === "ready" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />}
                <span className="min-w-0"><span data-preserve-language className="block text-[11px] font-bold text-slate-800">{gate.label}</span><span data-preserve-language className="mt-0.5 block font-mono text-[9px] text-slate-400">{gate.id}</span><span data-preserve-language className="mt-1 block text-[10px] leading-4 text-slate-600">{gate.detail}</span></span>
              </div>)}
            </div>
          </div>
        </div></>}
      </section>

      <section id="advanced-governance" ref={advancedRef} className="scroll-mt-24 overflow-hidden rounded-2xl border border-[#dfe5ee] bg-white shadow-sm">
        <button ref={advancedTriggerRef} type="button" aria-expanded={advancedOpen} aria-controls="advanced-governance-content" onClick={(event) => { advancedReturnFocusRef.current = event.currentTarget; setAdvancedOpen((current) => !current); }} className="flex w-full items-center justify-between gap-5 px-5 py-4 text-left transition hover:bg-[#fbfcfe]">
          <span className="flex min-w-0 items-center gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600"><ShieldCheck className="size-4" /></span><span><span className="block text-sm font-bold text-[#273247]">高级治理</span><span className="mt-1 block text-xs leading-5 text-[#778195]">发布就绪、部署模式、文档门禁、安全事件与连接器控制面。</span></span></span>
          <ChevronDown className={cn("size-4 shrink-0 text-[#8b95a5] transition", advancedOpen && "rotate-180")} />
        </button>
        {advancedOpen && <div id="advanced-governance-content" className="space-y-5 border-t border-[#edf0f4] bg-[#f8fafc] p-5">
          <ProcurementV1ReadinessPanel onNavigate={onNavigate} operationsManageable={connectionsManageable} />
          <ProcurementDeploymentProfilePanel />
          {connectionsManageable ? children : administrationBoundary}
        </div>}
      </section>
      </>}
    </div>
  );
}
