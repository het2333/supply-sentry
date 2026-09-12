"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleAlert, ExternalLink, Loader2, RefreshCw, ScanLine, Search, Settings2, Wifi } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { apiRequest } from "@/features/shared/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

type PlatformState = "unconfigured" | "configured" | "connected" | "degraded" | "paused" | "blocked" | "unreachable";

interface HermesEnvironmentField {
  key: string;
  required: boolean;
  isSet: boolean;
  isPassword: boolean;
  advanced: boolean;
}

interface HermesPlatform {
  id: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  gatewayRunning: boolean;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string | null;
  docsUrl: string;
  envVars: HermesEnvironmentField[];
  onboarding: "telegram" | "whatsapp" | "weixin" | null;
}

interface HermesCatalog {
  platforms: HermesPlatform[];
  stale: boolean;
  capturedAt: string;
  warning?: string;
  permissions: { manage: boolean };
}

interface HermesHealth {
  status: "running" | "blocked" | "unreachable";
  checkedAt?: string;
  sidecar: { ok: boolean };
  bridge: { ok: boolean; reason?: string };
  inboxOutbox: { inboxPending: number; outboxPending: number; unknownDeliveries: number };
}

interface OnboardingState {
  pairingId: string;
  status: string;
  qrPayload: string;
  expiresAt: string;
  ownerUserId: string;
  accountName: string;
}

interface WecomSetupReadiness {
  callbackUrl: string | null;
  ready: boolean;
  reason: string | null;
}

const statePresentation: Record<PlatformState, { label: string; tone: "green" | "amber" | "red" | "neutral" }> = {
  unconfigured: { label: "未配置", tone: "neutral" },
  configured: { label: "已配置", tone: "amber" },
  connected: { label: "已连接", tone: "green" },
  degraded: { label: "性能下降", tone: "amber" },
  paused: { label: "已暂停", tone: "neutral" },
  blocked: { label: "已阻塞", tone: "red" },
  unreachable: { label: "无法连接", tone: "red" },
};

const channelNames: Record<string, string> = {
  local: "本地终端",
  telegram: "电报",
  discord: "Discord 社群",
  whatsapp: "WhatsApp",
  whatsapp_cloud: "WhatsApp 云接口",
  slack: "Slack 协作通信",
  signal: "信号安全通信",
  mattermost: "Mattermost 协作通信",
  matrix: "Matrix 联邦通信",
  homeassistant: "家庭自动化",
  email: "邮件",
  sms: "短信",
  dingtalk: "钉钉",
  api_server: "接口服务",
  webhook: "网络回调",
  msgraph_webhook: "微软企业消息",
  feishu: "飞书",
  wecom: "企业微信机器人",
  wecom_callback: "企业微信应用",
  weixin: "微信",
  bluebubbles: "苹果消息",
  qqbot: "QQ 机器人",
  yuanbao: "元宝",
  relay: "中继服务",
};

function opaqueReference(value: string): string {
  let hash = BigInt("14695981039346656037");
  for (const character of value) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * BigInt("1099511628211"));
  return hash.toString(16).slice(0, 8).toUpperCase();
}

function platformLabel(platform: HermesPlatform): string {
  return (channelNames[platform.id] ?? platform.name.trim()) || `扩展消息渠道 ${opaqueReference(platform.id)}`;
}

function platformState(platform: HermesPlatform): PlatformState {
  const state = platform.state.toLowerCase();
  if (!platform.configured) return "unconfigured";
  if (!platform.gatewayRunning) return "unreachable";
  if (platform.errorCode || /blocked|error|failed/u.test(state)) return "blocked";
  if (!platform.enabled || /paused|disabled/u.test(state)) return "paused";
  if (/connected|running|ready/u.test(state)) return "connected";
  if (/degraded|reconnect|timeout/u.test(state)) return "degraded";
  return "configured";
}

function idempotencyKey(action: "configure" | "test", platformId: string): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `hermes-platform:${action}:${platformId}:${suffix}`;
}

function randomUrlSafeValue(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败";
}

function onboardingFrom(value: Record<string, unknown>): OnboardingState {
  return {
    pairingId: typeof value.pairing_id === "string" ? value.pairing_id : "",
    status: typeof value.status === "string" ? value.status : "waiting",
    qrPayload: typeof value.qr_payload === "string" ? value.qr_payload : "",
    expiresAt: typeof value.expires_at === "string" ? value.expires_at : "",
    ownerUserId: typeof value.owner_user_id === "string" ? value.owner_user_id : "",
    accountName: typeof value.account_name === "string"
      ? value.account_name
      : typeof value.bot_username === "string" ? value.bot_username : "",
  };
}

export function HermesPlatformsPanel() {
  const [catalog, setCatalog] = useState<HermesCatalog | null>(null);
  const [health, setHealth] = useState<HermesHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | PlatformState>("all");
  const [selected, setSelected] = useState<HermesPlatform | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [clearFields, setClearFields] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [checkingOnboarding, setCheckingOnboarding] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [allowedUsers, setAllowedUsers] = useState("");
  const [wecomReadiness, setWecomReadiness] = useState<WecomSetupReadiness | null>(null);
  const [wecomCallbackToken, setWecomCallbackToken] = useState("");
  const [wecomEncodingAesKey, setWecomEncodingAesKey] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setReadError(null);
    const [catalogResult, healthResult] = await Promise.allSettled([
      apiRequest<HermesCatalog>("/api/messaging/platforms"),
      apiRequest<HermesHealth>("/api/messaging/hermes/health"),
    ]);
    if (catalogResult.status === "fulfilled" && Array.isArray(catalogResult.value.platforms)) {
      setCatalog(catalogResult.value);
    } else {
      setReadError(catalogResult.status === "rejected" ? errorText(catalogResult.reason) : "消息渠道目录格式无效");
    }
    if (healthResult.status === "fulfilled" && healthResult.value?.sidecar && healthResult.value?.inboxOutbox) {
      setHealth(healthResult.value);
    } else {
      setHealth(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => (catalog?.platforms ?? []).filter((platform) => {
    const status = platformState(platform);
    const searchable = `${platformLabel(platform)} ${statePresentation[status].label}`.toLowerCase();
    return (statusFilter === "all" || status === statusFilter) && searchable.includes(query.trim().toLowerCase());
  }).sort((left, right) => Number(right.id === "weixin") - Number(left.id === "weixin")), [catalog, query, statusFilter]);

  const mutationsDisabled = !catalog || catalog.stale || !catalog.permissions.manage || loading || submitting;

  function openConfiguration(platform: HermesPlatform) {
    setSelected(platform);
    setEnabled(platform.id === "wecom_callback" ? true : platform.enabled);
    setValues({});
    setClearFields([]);
    setOperationError(null);
    setOnboarding(null);
    setCheckingOnboarding(false);
    setAllowedUsers("");
    setWecomReadiness(null);
    setWecomCallbackToken("");
    setWecomEncodingAesKey("");
    if (platform.id === "wecom_callback") {
      setWecomCallbackToken(randomUrlSafeValue(18));
      setWecomEncodingAesKey(randomUrlSafeValue(32));
      void apiRequest<WecomSetupReadiness>("/api/messaging/wecom/setup-readiness")
        .then((readiness) => setWecomReadiness(readiness))
        .catch((error) => setWecomReadiness({ callbackUrl: null, ready: false, reason: errorText(error) }));
    }
  }

  async function configureSelected() {
    if (!selected || mutationsDisabled) return;
    setSubmitting(true);
    setOperationError(null);
    try {
      const env = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()]));
      await apiRequest(`/api/messaging/platforms/${encodeURIComponent(selected.id)}`, {
        method: "PUT",
        headers: { "Idempotency-Key": idempotencyKey("configure", selected.id) },
        body: { enabled, env, clearEnv: clearFields },
      });
      setNotice(`${platformLabel(selected)}渠道配置已保存`);
      setSelected(null);
      await load();
    } catch (error) {
      setOperationError(errorText(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function testPlatform(platform: HermesPlatform) {
    if (mutationsDisabled) return;
    setSubmitting(true);
    setOperationError(null);
    setNotice(null);
    try {
      const result = await apiRequest<{ ok: boolean; message?: string }>(`/api/messaging/platforms/${encodeURIComponent(platform.id)}/test`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey("test", platform.id) },
      });
      setNotice(result.message ?? (result.ok ? "渠道连接测试成功" : "渠道连接测试未通过"));
    } catch (error) {
      setNotice(null);
      setOperationError(errorText(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function configureWecomApplication() {
    if (!selected || selected.id !== "wecom_callback" || mutationsDisabled) return;
    if (!wecomReadiness?.ready) {
      setOperationError(wecomReadiness?.reason ?? "正在确认企业微信公网 HTTPS 回调地址");
      return;
    }
    const corpId = values.WECOM_CALLBACK_CORP_ID?.trim() ?? "";
    const corpSecret = values.WECOM_CALLBACK_CORP_SECRET?.trim() ?? "";
    const agentId = values.WECOM_CALLBACK_AGENT_ID?.trim() ?? "";
    if (!corpId || !corpSecret || !agentId || !wecomCallbackToken || !wecomEncodingAesKey) {
      setOperationError("请填写企业 ID、应用 Secret 和 AgentId");
      return;
    }
    setSubmitting(true);
    setOperationError(null);
    try {
      const env = {
        WECOM_CALLBACK_CORP_ID: corpId,
        WECOM_CALLBACK_CORP_SECRET: corpSecret,
        WECOM_CALLBACK_AGENT_ID: agentId,
        WECOM_CALLBACK_TOKEN: wecomCallbackToken,
        WECOM_CALLBACK_ENCODING_AES_KEY: wecomEncodingAesKey,
      };
      await apiRequest(`/api/messaging/platforms/${encodeURIComponent(selected.id)}`, {
        method: "PUT",
        headers: { "Idempotency-Key": idempotencyKey("configure", selected.id) },
        body: { enabled: true, env, clearEnv: [] },
      });
      const tested = await apiRequest<{ ok: boolean; message?: string }>(`/api/messaging/platforms/${encodeURIComponent(selected.id)}/test`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey("test", selected.id) },
      });
      if (!tested.ok) throw new Error(tested.message ?? "企业微信应用适配器尚未通过连接测试");
      setNotice("企业微信应用已保存，Hermes 适配器已启动；请继续在企业微信后台完成公网回调验证。");
      setSelected(null);
      setWecomReadiness(null);
      setWecomCallbackToken("");
      setWecomEncodingAesKey("");
      await load();
    } catch (error) {
      setOperationError(errorText(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function startOnboarding() {
    if (!selected?.onboarding || mutationsDisabled) return;
    setSubmitting(true);
    setOperationError(null);
    try {
      const body = selected.onboarding === "telegram"
        ? { bot_name: "Readywork 采购助手" }
        : { mode: "bot", allowed_users: allowedUsers };
      const result = await apiRequest<Record<string, unknown>>(`/api/messaging/onboarding/${selected.onboarding}/start`, { method: "POST", body });
      const next = onboardingFrom(result);
      if (!next.pairingId) throw new Error("引导服务未返回会话标识");
      setOnboarding(next);
    } catch (error) {
      setOperationError(errorText(error));
    } finally {
      setSubmitting(false);
    }
  }

  const checkOnboarding = useCallback(async () => {
    if (!selected?.onboarding || !onboarding?.pairingId || submitting || checkingOnboarding) return;
    setCheckingOnboarding(true);
    setOperationError(null);
    try {
      const result = await apiRequest<Record<string, unknown>>(`/api/messaging/onboarding/${selected.onboarding}/${encodeURIComponent(onboarding.pairingId)}`);
      const next = { ...onboarding, ...onboardingFrom({ ...result, pairing_id: onboarding.pairingId, qr_payload: onboarding.qrPayload, expires_at: onboarding.expiresAt }) };
      setOnboarding(next);
      if (next.ownerUserId) setAllowedUsers(next.ownerUserId);
    } catch (error) {
      setOperationError(errorText(error));
      setOnboarding((current) => current ? { ...current, status: "error" } : current);
    } finally {
      setCheckingOnboarding(false);
    }
  }, [checkingOnboarding, onboarding, selected, submitting]);

  const applyOnboarding = useCallback(async () => {
    if (!selected?.onboarding || !onboarding?.pairingId || submitting || checkingOnboarding) return;
    const ids = allowedUsers.split(/[,\s]+/u).map((value) => value.trim()).filter(Boolean);
    if (selected.onboarding === "telegram" && ids.length === 0) {
      setOperationError("请填写允许使用机器人的电报用户编号");
      return;
    }
    setSubmitting(true);
    setOperationError(null);
    try {
      const body = selected.onboarding === "telegram"
        ? { allowed_user_ids: ids }
        : selected.onboarding === "whatsapp" ? { mode: "bot", allowed_users: allowedUsers.trim() } : {};
      await apiRequest(`/api/messaging/onboarding/${selected.onboarding}/${encodeURIComponent(onboarding.pairingId)}/apply`, { method: "POST", body });
      setNotice(`${platformLabel(selected)}已完成接入`);
      setSelected(null);
      await load();
    } catch (error) {
      setOperationError(errorText(error));
    } finally {
      setSubmitting(false);
    }
  }, [allowedUsers, checkingOnboarding, load, onboarding, selected, submitting]);

  useEffect(() => {
    if (!selected?.onboarding || !onboarding?.pairingId || submitting || checkingOnboarding) return;
    if (!["waiting", "starting", "installing", "scanned", "scaned"].includes(onboarding.status)) return;
    const timer = window.setTimeout(() => { void checkOnboarding(); }, 2_000);
    return () => window.clearTimeout(timer);
  }, [checkOnboarding, checkingOnboarding, onboarding, selected, submitting]);

  useEffect(() => {
    if (selected?.onboarding !== "weixin" || !onboarding || submitting || checkingOnboarding) return;
    if (["ready", "connected"].includes(onboarding.status)) void applyOnboarding();
  }, [applyOnboarding, checkingOnboarding, onboarding, selected, submitting]);

  async function closeConfiguration() {
    if (submitting) return;
    const platform = selected?.onboarding;
    const pairingId = onboarding?.pairingId;
    if (platform && pairingId && !["ready", "connected", "cancelled", "expired", "error"].includes(onboarding?.status ?? "")) {
      setSubmitting(true);
      setOperationError(null);
      try {
        await apiRequest(`/api/messaging/onboarding/${platform}/${encodeURIComponent(pairingId)}`, { method: "DELETE" });
      } catch (error) {
        setOperationError(errorText(error));
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
    }
    setSelected(null);
    setOnboarding(null);
    setCheckingOnboarding(false);
    setWecomReadiness(null);
    setWecomCallbackToken("");
    setWecomEncodingAesKey("");
  }

  const healthState = health?.status ?? "unreachable";
  const selectedLabel = selected ? platformLabel(selected) : "消息渠道";
  const onboardingReady = onboarding && ["ready", "connected"].includes(onboarding.status);
  const onboardingTerminalError = onboarding && ["expired", "cancelled", "error"].includes(onboarding.status);
  const isWecomApplication = selected?.id === "wecom_callback";
  const configurationFields = selected ? <>
    <label className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-3 text-sm font-medium text-slate-800"><span>启用此渠道</span><input type="checkbox" checked={enabled} disabled={submitting} onChange={(event) => setEnabled(event.target.checked)} className="size-4" /></label>
    {selected.envVars.map((field, index) => <div key={field.key} className="rounded-xl border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-2"><label htmlFor={`hermes-field-${index}`} className="text-sm font-medium text-slate-800">配置项 {index + 1}{field.required ? "（必填）" : "（可选）"}</label><Badge tone={field.isSet ? "green" : "neutral"}>{field.isSet ? "已保存" : "未保存"}</Badge></div>
      <code data-preserve-language className="mt-1 block text-[11px] text-slate-400">{field.key}</code>
      <input id={`hermes-field-${index}`} aria-label={`${selectedLabel}：配置项 ${index + 1}`} type={field.isPassword ? "password" : "text"} autoComplete="off" value={values[field.key] ?? ""} disabled={submitting || clearFields.includes(field.key)} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.isSet ? "留空则保留已保存值" : "请输入配置值"} className="mt-2 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-blue-500" />
      {field.isSet ? <label className="mt-2 flex items-center gap-2 text-xs text-slate-500"><input type="checkbox" checked={clearFields.includes(field.key)} disabled={submitting} onChange={(event) => setClearFields((current) => event.target.checked ? [...current, field.key] : current.filter((key) => key !== field.key))} />清除已保存值</label> : null}
    </div>)}
  </> : null;
  const wecomApplicationForm = selected ? <div className="space-y-4">
    <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950">
      <div className="flex items-center gap-2 font-semibold"><ScanLine className="size-4" />企业微信应用接入</div>
      <p className="mt-1 text-xs leading-5 text-blue-800">按下面三步完成配置。平台只在当前页面生成 Token 和 AESKey，关闭页面后即丢弃。</p>
    </div>
    <section className="rounded-xl border border-slate-200 p-3" aria-label="企业微信应用：步骤一">
      <h3 className="text-sm font-semibold text-slate-800">1. 填写企业微信后台回调</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">在企业微信自建应用的“接收消息”中使用下面的公网 HTTPS 回调地址、Token 与 AESKey。</p>
      <label className="mt-3 block text-xs font-medium text-slate-700">公网 HTTPS 回调地址
        <input aria-label="企业微信应用：公网 HTTPS 回调地址" readOnly value={wecomReadiness?.callbackUrl ?? ""} placeholder={wecomReadiness ? "尚未配置" : "正在读取部署状态…"} className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 outline-none" />
      </label>
      {!wecomReadiness ? <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500"><Loader2 className="size-3 animate-spin" />正在确认回调地址…</p> : null}
      {wecomReadiness?.reason ? <p role="alert" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-800">{wecomReadiness.reason}。请先由部署管理员配置 TLS 反向代理，再返回此页面。</p> : null}
      <label className="mt-3 block text-xs font-medium text-slate-700">回调 Token
        <input aria-label="企业微信应用：回调 Token" readOnly value={wecomCallbackToken} className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-sm text-slate-700 outline-none" />
      </label>
      <label className="mt-3 block text-xs font-medium text-slate-700">AESKey
        <input aria-label="企业微信应用：AESKey" readOnly value={wecomEncodingAesKey} className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-sm text-slate-700 outline-none" />
      </label>
    </section>
    <section className="rounded-xl border border-slate-200 p-3" aria-label="企业微信应用：步骤二">
      <h3 className="text-sm font-semibold text-slate-800">2. 粘贴企业微信应用信息</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">仅企业微信管理员可在官方后台取得这些信息；已保存的值不会回填。</p>
      <label className="mt-3 block text-xs font-medium text-slate-700">企业 ID
        <input aria-label="企业微信应用：企业 ID" autoComplete="off" value={values.WECOM_CALLBACK_CORP_ID ?? ""} onChange={(event) => setValues((current) => ({ ...current, WECOM_CALLBACK_CORP_ID: event.target.value }))} className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-blue-500" />
      </label>
      <label className="mt-3 block text-xs font-medium text-slate-700">应用 Secret
        <input aria-label="企业微信应用：应用 Secret" type="password" autoComplete="new-password" value={values.WECOM_CALLBACK_CORP_SECRET ?? ""} onChange={(event) => setValues((current) => ({ ...current, WECOM_CALLBACK_CORP_SECRET: event.target.value }))} className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-blue-500" />
      </label>
      <label className="mt-3 block text-xs font-medium text-slate-700">AgentId
        <input aria-label="企业微信应用：AgentId" autoComplete="off" value={values.WECOM_CALLBACK_AGENT_ID ?? ""} onChange={(event) => setValues((current) => ({ ...current, WECOM_CALLBACK_AGENT_ID: event.target.value }))} className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-blue-500" />
      </label>
    </section>
    <section className="rounded-xl border border-slate-200 p-3" aria-label="企业微信应用：步骤三">
      <h3 className="text-sm font-semibold text-slate-800">3. 保存并测试</h3>
      <p className="mt-1 text-xs leading-5 text-slate-500">平台会一次性保存五项配置并调用 Hermes 真实测试。通过测试不代表企业微信公网回调已完成官方验证。</p>
      <Button type="button" size="sm" className="mt-3" aria-label="保存并测试企业微信应用" disabled={mutationsDisabled || !wecomReadiness?.ready || !(values.WECOM_CALLBACK_CORP_ID?.trim() && values.WECOM_CALLBACK_CORP_SECRET?.trim() && values.WECOM_CALLBACK_AGENT_ID?.trim())} onClick={() => void configureWecomApplication()}>{submitting ? "保存并测试中…" : "保存并测试企业微信应用"}</Button>
    </section>
  </div> : null;

  return <section aria-label="Hermes 消息渠道" className="space-y-3">
    <Card>
      <CardHeader>
        <div>
          <div className="flex flex-wrap items-center gap-2"><CardTitle>消息渠道</CardTitle><Badge tone={healthState === "running" ? "green" : healthState === "blocked" ? "red" : "amber"}>{healthState === "running" ? "网关运行中" : healthState === "blocked" ? "网关已阻塞" : "网关无法连接"}</Badge></div>
          <CardDescription>渠道来自 Hermes 官方实时目录；配置、测试、扫码接入和投递状态均读取真实服务事实。</CardDescription>
        </div>
        <Button type="button" variant="outline" size="sm" aria-label="重新读取消息渠道" disabled={loading || submitting} onClick={() => void load()}><RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />重新读取</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {health ? <dl className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs sm:grid-cols-5">
          <div><dt className="text-slate-400">Hermes 侧车</dt><dd className="mt-1 font-semibold text-slate-700">{health.sidecar.ok ? "正常" : "不可达"}</dd></div>
          <div><dt className="text-slate-400">安全桥接</dt><dd className="mt-1 font-semibold text-slate-700">{health.bridge.ok ? "正常" : "不可达"}</dd></div>
          <div><dt className="text-slate-400">待处理入站</dt><dd className="mt-1 font-semibold text-slate-700">{health.inboxOutbox.inboxPending}</dd></div>
          <div><dt className="text-slate-400">待投递出站</dt><dd className="mt-1 font-semibold text-slate-700">{health.inboxOutbox.outboxPending}</dd></div>
          <div><dt className="text-slate-400">结果未知</dt><dd className={health.inboxOutbox.unknownDeliveries ? "mt-1 font-semibold text-red-600" : "mt-1 font-semibold text-slate-700"}>{health.inboxOutbox.unknownDeliveries}</dd></div>
        </dl> : null}
        {catalog?.stale ? <div role="alert" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><CircleAlert className="mt-0.5 size-4 shrink-0" />Hermes 当前不可达，正在显示上次成功快照；配置、测试和接入操作已禁用。</div> : null}
        {readError ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">无法读取消息渠道：{readError}</div> : null}
        {notice ? <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-700">{notice}</div> : null}
        {operationError && !selected ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">{operationError}</div> : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-slate-400" /><input aria-label="搜索消息渠道" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索渠道名称或状态" className="h-9 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:border-blue-500" /></label>
          <select aria-label="按状态筛选" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)} className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-blue-500">
            <option value="all">全部状态</option>
            {Object.entries(statePresentation).map(([value, presentation]) => <option key={value} value={value}>{presentation.label}</option>)}
          </select>
        </div>

        {loading && !catalog ? <div role="status" className="flex min-h-28 items-center justify-center text-sm text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" />正在读取 Hermes 渠道目录…</div> : null}
        {catalog && filtered.length === 0 ? <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">没有匹配的消息渠道。</div> : null}
        {catalog && filtered.length > 0 ? <div className="grid gap-3 md:grid-cols-2">
          {filtered.map((platform) => {
            const status = platformState(platform);
            const presentation = statePresentation[status];
            const label = platformLabel(platform);
            return <article key={platform.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-slate-900">{label}</h3><Badge tone={presentation.tone}>{presentation.label}</Badge></div><p className="mt-1.5 text-xs leading-5 text-slate-500">Hermes 官方适配器 · {platform.envVars.length} 个配置项{platform.onboarding ? " · 支持扫码引导" : ""}</p></div>
                <span className={status === "connected" ? "rounded-lg bg-emerald-50 p-2 text-emerald-600" : "rounded-lg bg-slate-50 p-2 text-slate-400"}><Wifi className="size-4" /></span>
              </div>
              {platform.errorMessage ? <p className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">运行详情：{platform.errorMessage}</p> : null}
              <div className="mt-4 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" aria-label={`配置${label}`} disabled={mutationsDisabled} onClick={() => openConfiguration(platform)}><Settings2 className="size-3.5" />配置</Button>
                <Button type="button" size="sm" variant="secondary" aria-label={`测试${label}连接`} disabled={mutationsDisabled || !platform.configured} onClick={() => void testPlatform(platform)}><Wifi className="size-3.5" />测试连接</Button>
              </div>
            </article>;
          })}
        </div> : null}
      </CardContent>
    </Card>

    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) void closeConfiguration(); }}>
      <DialogContent closeLabel="关闭渠道配置">
        <DialogTitle>配置{selectedLabel}</DialogTitle>
        <DialogDescription className="mt-2">{isWecomApplication ? "先配置企业微信后台回调，再保存应用凭据并执行真实连接测试。" : selected?.onboarding === "weixin" ? "手机微信扫码确认后，平台会自动完成配置，无需复制账号或 Token。" : "凭据值只会提交给后端和 Hermes，已保存的密文不会回填到浏览器。"}</DialogDescription>
        {selected ? <div className="mt-5 max-h-[58vh] space-y-4 overflow-y-auto pr-1">
          {selected.onboarding ? <div className="rounded-xl border border-blue-100 bg-blue-50 p-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-blue-900"><ScanLine className="size-4" />{selected.onboarding === "weixin" ? "手机微信扫码" : "扫码引导接入"}</div>
            {!onboarding ? <>
              <p className="mt-1 text-xs leading-5 text-blue-700">{selected.onboarding === "weixin" ? "二维码由 Hermes 的腾讯 iLink 适配器实时生成；确认后凭据只保存在服务端。" : "由 Hermes 官方引导服务创建一次性会话，不会伪造连接结果。"}</p>
              <Button type="button" size="sm" className="mt-3" disabled={mutationsDisabled} onClick={() => void startOnboarding()}>{selected.onboarding === "weixin" ? "生成微信二维码" : "启动扫码接入"}</Button>
            </> : <div className="mt-3 space-y-3 text-xs text-blue-800">
              <p className="font-semibold">{onboardingTerminalError ? "扫码会话已失效" : onboardingReady ? selected.onboarding === "weixin" ? "已确认，正在自动保存" : "账号已确认" : ["scanned", "scaned"].includes(onboarding.status) ? "已扫码，请在微信中确认" : "等待扫码"}{onboarding.accountName ? ` · ${onboarding.accountName}` : ""}</p>
              {onboarding.qrPayload && !onboardingTerminalError ? selected.onboarding === "weixin" ? <div className="flex flex-col items-center rounded-xl border border-blue-200 bg-white p-4 text-center">
                <QRCodeSVG value={onboarding.qrPayload} size={208} level="M" marginSize={2} aria-label="微信登录二维码" />
                <p className="mt-3 font-medium text-slate-700">打开手机微信“扫一扫”，并在手机上确认</p>
              </div> : <div className="rounded-lg border border-blue-200 bg-white p-3"><p className="font-medium">扫码内容</p><code data-preserve-language className="mt-1 block break-all text-[11px] text-slate-600">{onboarding.qrPayload}</code>{/^(?:https?:|tg:)/u.test(onboarding.qrPayload) ? <a href={onboarding.qrPayload} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-medium text-blue-600">在对应应用中打开<ExternalLink className="size-3" /></a> : null}</div> : null}
              {onboarding.expiresAt ? <p>会话过期时间：<span data-preserve-language>{onboarding.expiresAt}</span></p> : null}
              {selected.onboarding === "weixin" && !onboardingReady && !onboardingTerminalError ? <p className="flex items-center gap-1.5"><Loader2 className="size-3 animate-spin" />平台正在自动检查扫码结果</p> : null}
              {onboardingReady && selected.onboarding !== "weixin" ? <label className="block font-medium">{selected.onboarding === "telegram" ? "允许使用的电报用户编号" : "允许使用的 WhatsApp 账号"}<input aria-label="允许使用的账号" value={allowedUsers} onChange={(event) => setAllowedUsers(event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-blue-200 bg-white px-3 text-sm outline-none focus:border-blue-500" /></label> : null}
              <div className="flex flex-wrap gap-2">
                {!onboardingReady && !onboardingTerminalError ? <Button type="button" size="sm" variant="outline" disabled={submitting || checkingOnboarding} onClick={() => void checkOnboarding()}>{selected.onboarding === "weixin" ? "立即检查" : "检查扫码结果"}</Button> : null}
                {onboardingReady && selected.onboarding !== "weixin" ? <Button type="button" size="sm" disabled={submitting} onClick={() => void applyOnboarding()}>完成接入</Button> : null}
                {onboardingTerminalError ? <Button type="button" size="sm" onClick={() => { setOnboarding(null); setOperationError(null); }}>重新生成</Button> : null}
              </div>
            </div>}
          </div> : null}

          {isWecomApplication ? wecomApplicationForm : selected.onboarding === "weixin" ? <details className="rounded-xl border border-slate-200 bg-slate-50 p-3"><summary className="cursor-pointer text-sm font-medium text-slate-600">高级手动配置</summary><div className="mt-3 space-y-3">{configurationFields}<Button type="button" size="sm" variant="outline" disabled={mutationsDisabled || checkingOnboarding} onClick={() => void configureSelected()}>{submitting ? "保存中…" : "保存手动配置"}</Button></div></details> : configurationFields}
          {selected.docsUrl ? <a href={selected.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">打开官方配置说明<ExternalLink className="size-3" /></a> : null}
          {operationError ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">{operationError}</div> : null}
        </div> : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <DialogClose asChild><Button type="button" variant="outline" size="sm" disabled={submitting}>取消</Button></DialogClose>
          {selected && !isWecomApplication ? <Button type="button" size="sm" variant="secondary" disabled={mutationsDisabled || !selected.configured} onClick={() => void testPlatform(selected)}>测试连接</Button> : null}
          {selected?.onboarding !== "weixin" && !isWecomApplication ? <Button type="button" size="sm" disabled={mutationsDisabled} onClick={() => void configureSelected()}>{submitting ? "保存中…" : "保存渠道配置"}</Button> : null}
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}
