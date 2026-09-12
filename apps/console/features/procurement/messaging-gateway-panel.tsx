"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleAlert, Loader2, Pause, Play, RefreshCw } from "lucide-react";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { HermesPlatformsPanel } from "@/features/procurement/hermes-platforms-panel";

type AdapterStatus = "running" | "degraded" | "paused" | "paused_by_breaker" | "disabled" | "unconfigured";

interface GatewayAdapter {
  id: string;
  channel: string;
  provider: string;
  status: AdapterStatus;
  capabilities: string[];
  version: number;
  consecutiveFailures: number;
  lastHealthAt: string | null;
  lastError: string | null;
  pauseReason: string | null;
  pendingInbound: number;
  pendingDeliveries: number;
  exceptionalDeliveries: number;
}

interface GatewaySummary {
  status: "running" | "degraded" | "blocked";
  checkedAt: string;
  adapters: GatewayAdapter[];
  permissions: { manage: boolean };
}

type GatewayAction = "pause" | "resume";
type PendingAction = { adapter: GatewayAdapter; action: GatewayAction };

const statusPresentation: Record<AdapterStatus, { label: string; tone: "green" | "amber" | "red" | "neutral" }> = {
  running: { label: "运行中", tone: "green" },
  degraded: { label: "性能下降", tone: "amber" },
  paused: { label: "已暂停", tone: "amber" },
  paused_by_breaker: { label: "已熔断", tone: "red" },
  disabled: { label: "已禁用", tone: "neutral" },
  unconfigured: { label: "未配置", tone: "neutral" },
};

const channelLabels: Record<string, string> = {
  email: "邮件",
};

const providerLabels: Record<string, string> = {
  smtp: "标准邮件传输服务",
  imap: "邮件接收服务",
};

function opaqueReference(value: string): string {
  let hash = BigInt("14695981039346656037");
  for (const character of value) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0)!)) * BigInt("1099511628211"));
  return hash.toString(16).padStart(16, "0");
}

function channelLabel(channel: string): string {
  return channelLabels[channel] ?? `其他通信通道（${opaqueReference(channel)}）`;
}

function providerLabel(provider: string): string {
  return providerLabels[provider] ?? `其他服务提供方（${opaqueReference(provider)}）`;
}

function adapterChannelLabel(adapter: GatewayAdapter): string {
  if (adapter.id === "email" && adapter.channel === "email") return "邮件";
  if (adapter.id === "email-imap" && adapter.channel === "email") return "邮件接收";
  return `${channelLabel(adapter.channel)} · ${opaqueReference(adapter.id)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "无法读取消息网关状态";
}

function safeOperationalDetail(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[已隐藏]")
    .replace(/\b(password|token|secret|authorizationCode)\s*[:=]\s*\S+/giu, "$1：[已隐藏]");
}

function actionFor(adapter: GatewayAdapter): GatewayAction | null {
  if (adapter.status === "running" || adapter.status === "degraded") return "pause";
  if (adapter.status === "paused" || adapter.status === "paused_by_breaker") return "resume";
  return null;
}

function idempotencyKey(action: GatewayAction, adapter: GatewayAdapter): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `messaging-gateway:${action}:${adapter.id}:v${adapter.version}:${suffix}`;
}

export function MessagingGatewayPanel({ includePlatforms = true }: { includePlatforms?: boolean } = {}) {
  const [summary, setSummary] = useState<GatewaySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const readVersion = useRef(0);
  const submittingRef = useRef(false);

  const load = useCallback(async () => {
    const requestVersion = ++readVersion.current;
    setLoading(true);
    setReadError(null);
    try {
      const result = await apiRequest<GatewaySummary>("/api/messaging/gateway");
      if (requestVersion !== readVersion.current) return false;
      setSummary(result);
      return true;
    } catch (error) {
      if (requestVersion !== readVersion.current) return false;
      setReadError(errorText(error));
      return false;
    } finally {
      if (requestVersion === readVersion.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function openAction(adapter: GatewayAdapter, action: GatewayAction) {
    setPendingAction({ adapter, action });
    setReason("");
    setActionError(null);
    setRequiresRefresh(false);
  }

  async function submitAction() {
    if (submittingRef.current || requiresRefresh || !pendingAction || !reason.trim()) return;
    submittingRef.current = true;
    setSubmitting(true);
    setActionError(null);
    try {
      await apiRequest(`/api/messaging/adapters/${encodeURIComponent(pendingAction.adapter.id)}/${pendingAction.action}`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey(pendingAction.action, pendingAction.adapter) },
        body: { expectedVersion: pendingAction.adapter.version, reason: reason.trim() },
      });
      await load();
      setPendingAction(null);
      setReason("");
    } catch (error) {
      if (error instanceof ReadyworkApiError && error.status === 409) {
        setActionError("适配器状态已变化，请重新读取后确认下一步操作。" + (error.message ? ` ${error.message}` : ""));
        setRequiresRefresh(true);
      } else {
        setActionError(errorText(error));
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function rereadAfterConflict() {
    const loaded = await load();
    if (!loaded) return;
    setPendingAction(null);
    setReason("");
    setActionError(null);
    setRequiresRefresh(false);
  }

  const actionLabel = pendingAction?.action === "pause" ? "暂停" : "恢复";
  const canManage = summary?.permissions.manage === true;

  return <>{includePlatforms ? <HermesPlatformsPanel /> : null}<section aria-label="消息网关运行状态">
    <Card>
      <CardHeader>
        <div>
          <CardTitle>消息网关运行状态</CardTitle>
          <CardDescription>显示投递适配器的服务端运行事实；凭据状态与外部验证仍在上方连接卡中单独维护。</CardDescription>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading || submitting} aria-label="重新读取消息网关状态"><RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} />重新读取</Button>
      </CardHeader>
      <CardContent>
        {loading && !summary ? <div role="status" className="flex min-h-28 items-center justify-center text-sm text-slate-500"><Loader2 className="mr-2 size-4 animate-spin" />正在读取消息网关状态…</div> : null}
        {!loading && !summary ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-3 text-xs leading-5 text-red-700">消息网关状态读取失败，未展示任何推测的运行状态：<span data-preserve-language>{readError ?? "未知错误"}</span></div> : null}
        {summary ? <>
          {readError ? <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><CircleAlert className="mt-0.5 size-4 shrink-0" />最新消息网关状态读取失败，正在显示上次成功读取的只读状态：<span data-preserve-language>{readError}</span></div> : null}
          {!canManage ? <div className="mb-4 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2.5 text-xs leading-5 text-blue-800">当前角色可查看真实网关状态；暂停或恢复适配器需要管理员权限。</div> : null}
          {summary.adapters.length === 0 ? <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">暂无已注册的消息适配器。</div> : <div className="space-y-3">
            {summary.adapters.map((adapter) => {
              const status = statusPresentation[adapter.status];
              const action = actionFor(adapter);
              const operationalDetail = adapter.lastError ?? adapter.pauseReason;
              const adapterChannel = adapterChannelLabel(adapter);
              return <article key={adapter.id} className="rounded-xl border border-slate-200 px-4 py-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-slate-900">{adapterChannel}适配器</h3><Badge tone={status.tone}>{status.label}</Badge></div><p className="mt-1 text-xs text-slate-500">提供方：{providerLabel(adapter.provider)} · 版本 {adapter.version}</p></div>
                  {action ? <Button type="button" variant={action === "pause" ? "danger" : "secondary"} size="sm" aria-label={`${action === "pause" ? "暂停" : "恢复"}${adapterChannel}适配器`} disabled={!canManage || loading || submitting || Boolean(readError)} onClick={() => openAction(adapter, action)}>{action === "pause" ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}{action === "pause" ? "暂停" : "恢复"}</Button> : null}
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-[11px]"><div><dt className="text-slate-400">待处理入站</dt><dd className="mt-0.5 font-semibold text-slate-700">{adapter.pendingInbound}</dd></div><div><dt className="text-slate-400">待投递</dt><dd className="mt-0.5 font-semibold text-slate-700">{adapter.pendingDeliveries}</dd></div><div><dt className="text-slate-400">异常投递</dt><dd className="mt-0.5 font-semibold text-slate-700">{adapter.exceptionalDeliveries}</dd></div></dl>
                {operationalDetail ? <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800"><span className="font-semibold">运行详情：</span><span data-preserve-language>{safeOperationalDetail(operationalDetail)}</span></div> : null}
              </article>;
            })}
          </div>}
        </> : null}
      </CardContent>
    </Card>
    <Dialog open={Boolean(pendingAction)} onOpenChange={(open) => { if (!open && !submittingRef.current) setPendingAction(null); }}>
      <DialogContent closeLabel="关闭消息网关操作" onClickCapture={(event) => {
        const target = event.target as HTMLElement;
        if (submittingRef.current && target.closest('button[aria-label="关闭消息网关操作"]')) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}>
        <DialogTitle>{actionLabel} {pendingAction ? `${adapterChannelLabel(pendingAction.adapter)}适配器` : "适配器"}</DialogTitle>
        <DialogDescription className="mt-2">该操作会写入服务端持久化状态，并以当前版本提交。请说明操作原因。</DialogDescription>
        <label className="mt-5 block text-sm font-medium text-slate-800">操作原因<textarea aria-label="操作原因" value={reason} disabled={submitting} onChange={(event) => setReason(event.target.value)} className="mt-2 min-h-24 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-500" /></label>
        {actionError ? <div role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700">{actionError}</div> : null}
        <div className="mt-5 flex justify-end gap-2">
          {actionError ? <Button type="button" variant="outline" size="sm" onClick={() => void rereadAfterConflict()} disabled={submitting}>重新读取</Button> : null}
          <DialogClose asChild><Button type="button" variant="outline" size="sm" disabled={submitting}>取消</Button></DialogClose>
          <Button type="button" size="sm" variant={pendingAction?.action === "pause" ? "danger" : "default"} disabled={submitting || requiresRefresh || !reason.trim()} onClick={() => void submitAction()}>{submitting ? "提交中…" : `确认${actionLabel}`}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </section></>;
}
