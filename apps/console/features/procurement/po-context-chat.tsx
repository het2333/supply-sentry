"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AlertTriangle, Bot, CheckCircle2, FileText, Loader2, Paperclip, RefreshCw, Send, ShieldCheck, Sparkles, UserRound, X } from "lucide-react";
import { apiRequest } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import {
  normalizePoChatPayload,
  poChatAttachmentState,
  poChatErrorMessage,
  type PoChatPayload,
  type PoChatSuggestedAction,
} from "@/features/procurement/po-context-chat-view-model";
import { cn } from "@/lib/utils";
import { useProcurementRealtimeRefresh } from "@/features/procurement/realtime-events";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

const formatBytes = (bytes: number) => bytes < 1024
  ? `${bytes} B`
  : bytes < 1024 ** 2
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

function isPendingResponse(value: unknown): value is { pending: true; conversationId: string } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>)["pending"] === true);
}

function AttachmentStatus({ attachment }: { attachment: NonNullable<PoChatPayload["messages"][number]["attachment"]> }) {
  const state = poChatAttachmentState(attachment);
  const meta = state === "ready"
    ? { label: "已扫描并解析", detail: "该附件文本可进入后续模型上下文", icon: CheckCircle2, className: "border-emerald-200 bg-emerald-50 text-emerald-700" }
    : state === "blocked"
      ? { label: "已安全阻断", detail: "附件不会进入模型上下文", icon: AlertTriangle, className: "border-red-200 bg-red-50 text-red-700" }
      : { label: "等待 ClamAV / 解析", detail: "明确通过前不会把附件内容交给模型", icon: ShieldCheck, className: "border-amber-200 bg-amber-50 text-amber-700" };
  const Icon = meta.icon;
  return <div className={cn("mt-2 rounded-xl border px-3 py-2.5", meta.className)}>
    <div className="flex items-start gap-2.5"><FileText className="mt-0.5 size-4 shrink-0" /><div className="min-w-0 flex-1"><div className="truncate text-[11px] font-semibold">{attachment.fileName}</div><div className="mt-0.5 text-[10px] opacity-75">{formatBytes(attachment.sizeBytes)} · {attachment.detectedContentType ?? attachment.contentType}</div></div><span className="flex shrink-0 items-center gap-1 text-[10px] font-semibold"><Icon className="size-3" />{meta.label}</span></div>
    <div className="mt-1.5 text-[10px] leading-4 opacity-80">{meta.detail}</div>
  </div>;
}

function SuggestedAction({ action, available, onOpen }: { action: PoChatSuggestedAction; available: boolean; onOpen: () => void }) {
  return <button type="button" disabled={!available} onClick={onOpen} className="group w-full rounded-xl border border-[#dfe6ef] bg-white px-3 py-3 text-left transition hover:border-blue-300 hover:bg-blue-50/40 disabled:cursor-not-allowed disabled:opacity-50">
    <div className="flex items-start gap-2.5"><span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600"><Sparkles className="size-3.5" /></span><span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-[#20304a]">{action.label}</span><span className="mt-1 block text-[10px] leading-4 text-[#718198]">{action.description}</span><span className="mt-2 block text-[10px] font-semibold text-blue-600">{available ? "转到概览核对并确认" : "当前 PO 状态已不再提供该动作"}</span></span></div>
  </button>;
}

export function PoContextChat({
  purchaseOrderId,
  canOperate,
  availableActionIds,
  onOpenSuggestedAction,
}: {
  purchaseOrderId: string;
  canOperate: boolean;
  availableActionIds: readonly string[];
  onOpenSuggestedAction: (actionId: string) => void;
}) {
  const { formatShortDateTime } = useProcurementLocale();
  const [data, setData] = useState<PoChatPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const availableActions = useMemo(() => new Set(availableActionIds), [availableActionIds]);

  const load = useCallback(async (silent = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const response = await apiRequest<unknown>(`/api/po/chat?purchaseOrderId=${encodeURIComponent(purchaseOrderId)}`, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setData(normalizePoChatPayload(response));
        setError(null);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(poChatErrorMessage(cause));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [purchaseOrderId]);

  useProcurementRealtimeRefresh(["messages"], () => void load(true), 250);

  useEffect(() => {
    setData(null);
    setError(null);
    setNotice(null);
    setMessage("");
    setFile(null);
    idempotencyKeyRef.current = null;
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  const hasPendingAttachment = data?.messages.some((entry) => entry.attachment && poChatAttachmentState(entry.attachment) === "pending") === true;
  useEffect(() => {
    if (!hasPendingAttachment) return;
    const timer = window.setInterval(() => void load(true), 30_000);
    return () => window.clearInterval(timer);
  }, [hasPendingAttachment, load]);

  useEffect(() => {
    const node = messageListRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [data?.messages.length, sending]);

  const resetIdempotency = () => { idempotencyKeyRef.current = null; };

  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    resetIdempotency();
    setNotice(null);
    if (selected && selected.size > MAX_FILE_BYTES) {
      setFile(null);
      setError("单个聊天附件不能超过 8 MB。");
      event.target.value = "";
      return;
    }
    setFile(selected);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = message.trim();
    if (!content || sending || !canOperate || data?.conversation?.status === "archived") return;
    setSending(true);
    setError(null);
    setNotice(null);
    const form = new FormData();
    form.set("purchaseOrderId", purchaseOrderId);
    form.set("message", content);
    form.set("expectedVersion", String(data?.conversation?.version ?? 0));
    if (data?.conversation?.id) form.set("conversationId", data.conversation.id);
    if (data?.messages.length) form.set("history", JSON.stringify(data.messages.map((entry) => ({ role: entry.role, content: entry.content }))));
    if (file) form.set("file", file);
    idempotencyKeyRef.current ??= `po-chat:${purchaseOrderId}:${crypto.randomUUID()}`;
    try {
      const response = await apiRequest<unknown>("/api/po/chat", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKeyRef.current },
        body: form,
        timeoutMs: 90_000,
      });
      if (isPendingResponse(response)) {
        setNotice("消息已持久化，AI 回答仍在生成；页面会继续读取结果。");
        window.setTimeout(() => void load(true), 2_000);
      } else {
        setData(normalizePoChatPayload(response));
        setMessage("");
        setFile(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        idempotencyKeyRef.current = null;
      }
    } catch (cause) {
      setError(poChatErrorMessage(cause));
      const status = cause && typeof cause === "object" && "status" in cause ? Number((cause as { status?: unknown }).status) : 0;
      if (status === 409 || status === 408 || status === 0) await load(true);
    } finally {
      setSending(false);
    }
  };

  const suggestions = data?.suggestedActions ?? [];
  const displayNumber = data?.contextSummary.displayNumber || purchaseOrderId;
  const modelLabel = data?.model.route === "reasoning" ? "推理模型" : data?.model.route === "fast" ? "快速模型" : "自动分流";

  return <section aria-label="PO 上下文聊天" className="overflow-hidden rounded-2xl border border-[#dfe6ef] bg-[#f8faff] shadow-[0_1px_2px_rgba(15,23,42,.03)]">
    <div className="flex items-start justify-between gap-3 border-b border-[#e7edf5] bg-white px-4 py-4">
      <div className="flex min-w-0 items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#0b1b3c] text-white"><Bot className="size-4" /></span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold text-[#13203a]">PO 上下文助手</h3><span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[9px] font-semibold text-blue-700">SQLite 持久化</span></div><p className="mt-1 text-[10px] leading-4 text-[#718198]">绑定 {displayNumber}；回答只读取当前租户、当前用户与该 PO 的持久化事实。</p></div></div>
      <button type="button" disabled={refreshing || loading} onClick={() => void load(true)} aria-label="刷新 PO 聊天" className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[#dfe6ef] bg-white text-[#607089] hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} /></button>
    </div>

    {loading ? <div className="flex min-h-48 items-center justify-center text-xs text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />读取持久化会话…</div> : <>
      {error ? <div role="alert" className="mx-4 mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[11px] leading-5 text-red-700"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span>{error}</span></div> : null}
      {notice ? <div role="status" className="mx-4 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[11px] leading-5 text-amber-800">{notice}</div> : null}

      <div ref={messageListRef} className="max-h-[420px] min-h-[180px] space-y-4 overflow-y-auto px-4 py-4">
        {!data?.messages.length ? <div className="flex min-h-36 flex-col items-center justify-center px-4 text-center"><Sparkles className="size-6 text-blue-300" /><div className="mt-3 text-xs font-semibold text-[#34445d]">从这笔 PO 的真实上下文开始提问</div><p className="mt-1 max-w-sm text-[10px] leading-5 text-[#8795a8]">可询问当前阶段、供应商确认、行级差异、SLA、发运、收货和下一步。聊天不会直接发送邮件或修改 Odoo。</p><div className="mt-3 flex flex-wrap justify-center gap-2">{["当前处于什么阶段？", "有哪些交付风险？", "下一步需要我处理什么？"].map((prompt) => <button key={prompt} type="button" disabled={!canOperate} onClick={() => { setMessage(prompt); resetIdempotency(); }} className="rounded-full border border-[#dfe6ef] bg-white px-3 py-1.5 text-[10px] font-medium text-[#52627a] hover:border-blue-300 hover:text-blue-700 disabled:opacity-50">{prompt}</button>)}</div></div> : data.messages.map((entry) => {
          const assistant = entry.role === "assistant";
          return <article key={entry.id} className={cn("flex gap-2.5", assistant ? "justify-start" : "justify-end")}>
            {assistant ? <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#0b1b3c] text-white"><Bot className="size-3.5" /></span> : null}
            <div className={cn("min-w-0 max-w-[88%] rounded-2xl px-3.5 py-3", assistant ? entry.status === "failed" ? "border border-amber-200 bg-amber-50" : "border border-[#dfe6ef] bg-white" : "bg-[#17634f] text-white")}>
              <div className={cn("whitespace-pre-wrap break-words text-[11px] leading-5", assistant ? "text-[#40516a]" : "text-white")}>{entry.content}</div>
              {entry.attachment ? <AttachmentStatus attachment={entry.attachment} /> : null}
              <div className={cn("mt-2 flex flex-wrap items-center gap-2 text-[9px]", assistant ? "text-[#9aa5b4]" : "text-white/70")}><span>{formatShortDateTime(entry.createdAt || null, "时间未记录")}</span>{assistant ? <><span>· {entry.modelRoute === "reasoning" ? "推理" : entry.modelRoute === "fast" ? "快速" : "模型"}</span>{entry.usage?.["completion_tokens"] !== undefined ? <span>· 输出 {entry.usage["completion_tokens"]} tokens</span> : null}</> : null}</div>
            </div>
            {!assistant ? <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-[#dfe7e2] text-[#17634f]"><UserRound className="size-3.5" /></span> : null}
          </article>;
        })}
        {sending ? <div className="flex items-center gap-2.5"><span className="flex size-7 items-center justify-center rounded-lg bg-[#0b1b3c] text-white"><Bot className="size-3.5" /></span><div className="rounded-2xl border border-[#dfe6ef] bg-white px-3.5 py-3 text-[11px] text-[#718198]"><Loader2 className="mr-2 inline size-3.5 animate-spin" />正在读取 PO 上下文并生成回答…</div></div> : null}
      </div>

      {suggestions.length ? <div className="border-t border-[#e7edf5] bg-white px-4 py-4"><div className="mb-3 flex items-center justify-between"><div className="text-[11px] font-semibold text-[#34445d]">结构化建议</div><span className="text-[9px] text-[#8795a8]">仅定位真实动作，不会直接执行</span></div><div className="grid gap-2 sm:grid-cols-2">{suggestions.map((action) => <SuggestedAction key={action.id} action={action} available={availableActions.has(action.actionId)} onOpen={() => onOpenSuggestedAction(action.actionId)} />)}</div></div> : null}

      <form onSubmit={(event) => void submit(event)} className="border-t border-[#e7edf5] bg-white p-4">
        {file ? <div className="mb-3 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-[10px] text-blue-800"><Paperclip className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{file.name} · {formatBytes(file.size)}</span><button type="button" aria-label="移除聊天附件" onClick={() => { setFile(null); resetIdempotency(); if (fileInputRef.current) fileInputRef.current.value = ""; }} className="flex size-6 items-center justify-center rounded-md hover:bg-blue-100"><X className="size-3.5" /></button></div> : null}
        <div className="rounded-xl border border-[#d9e2ee] bg-white p-2 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100"><textarea value={message} onChange={(event) => { setMessage(event.target.value); resetIdempotency(); }} disabled={!canOperate || sending || data?.conversation?.status === "archived"} maxLength={4000} rows={3} placeholder={canOperate ? "询问这笔 PO 的阶段、差异、风险或下一步…" : "当前身份只有读取权限"} className="max-h-36 min-h-16 w-full resize-none bg-transparent px-1 text-[11px] leading-5 text-[#26364f] outline-none placeholder:text-[#a0a9b6] disabled:cursor-not-allowed" /><div className="mt-2 flex items-center justify-between gap-3"><div className="flex items-center gap-2"><input ref={fileInputRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.csv,.xlsx,.xls,.docx" onChange={selectFile} className="hidden" /><button type="button" disabled={!canOperate || sending} onClick={() => fileInputRef.current?.click()} className="flex h-8 items-center gap-1.5 rounded-lg border border-[#dfe6ef] px-2.5 text-[10px] font-semibold text-[#607089] hover:bg-slate-50 disabled:opacity-50"><Paperclip className="size-3.5" />附件</button><span className="hidden text-[9px] text-[#a0a9b6] sm:inline">最大 8 MB，先扫描再解析</span></div><button type="submit" disabled={!canOperate || sending || !message.trim() || data?.conversation?.status === "archived"} className="flex h-8 items-center gap-1.5 rounded-lg bg-[#0b1b3c] px-3 text-[10px] font-semibold text-white hover:bg-[#132955] disabled:cursor-not-allowed disabled:opacity-40">{sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}发送</button></div></div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[9px] leading-4 text-[#8795a8]"><span>模型分流：{modelLabel}{data?.model.maxTokens ? ` · 上限 ${data.model.maxTokens} tokens` : ""}</span><span>任何邮件、审批、ERP、发运或 GRN 操作仍需在概览中确认</span></div>
      </form>
    </>}
  </section>;
}
