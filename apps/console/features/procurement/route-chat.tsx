"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { AlertTriangle, Bot, CheckCircle2, Expand, FileText, Loader2, MessageSquarePlus, PanelLeftClose, Paperclip, Send, ShieldCheck, Shrink, Sparkles, UserRound, X } from "lucide-react";
import { apiRequest } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { cn } from "@/lib/utils";
import { normalizeRouteChatPayload, routeChatAttachmentState, routeChatErrorMessage, type RouteChatPayload, type RouteChatRoute, type RouteChatMessage } from "@/features/procurement/route-chat-view-model";

const FALLBACK_ACCEPT = [".pdf", ".csv", ".xlsx", ".docx", ".txt", ".md"];
const FALLBACK_MAX_FILE_BYTES = 8 * 1024 * 1024;

const formatBytes = (bytes: number) => bytes < 1024
  ? `${bytes} B`
  : bytes < 1024 ** 2
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

function AttachmentStatus({ attachment, onRetry, retrying, canMutate }: { attachment: NonNullable<RouteChatMessage["attachment"]>; onRetry: (trigger: HTMLButtonElement) => void; retrying: boolean; canMutate: boolean }) {
  const state = routeChatAttachmentState(attachment);
  const meta = state === "ready"
    ? { label: "已扫描并解析", detail: "附件文本已通过安全与解析门禁，可作为路线事实上下文。", icon: CheckCircle2, className: "border-emerald-200 bg-emerald-50 text-emerald-700" }
    : state === "blocked"
      ? { label: "扫描或解析失败", detail: "附件不会进入模型上下文；可对解析失败的文件重新排队。", icon: AlertTriangle, className: "border-red-200 bg-red-50 text-red-700" }
      : { label: "等待扫描 / 解析", detail: "明确通过前不会把附件内容交给模型。", icon: ShieldCheck, className: "border-amber-200 bg-amber-50 text-amber-700" };
  const Icon = meta.icon;
  const canRetry = canMutate && state === "blocked" && attachment.processingStatus === "parse_failed" && attachment.securityStatus !== "quarantined";
  return <div className={cn("mt-2 rounded-xl border px-3 py-2.5", meta.className)}>
    <div className="flex items-start gap-2.5"><FileText className="mt-0.5 size-4 shrink-0" /><div className="min-w-0 flex-1"><div data-preserve-language className="truncate text-[10px] font-semibold">{attachment.fileName}</div><div data-preserve-language className="mt-0.5 text-[9px] opacity-75">{formatBytes(attachment.sizeBytes)} · {attachment.detectedContentType ?? attachment.contentType}</div></div><span className="flex shrink-0 items-center gap-1 text-[9px] font-semibold"><Icon className="size-3" />{meta.label}</span></div>
    <div className="mt-1.5 text-[9px] leading-4 opacity-80">{meta.detail}</div>
    <div className="mt-1.5 flex items-center justify-between gap-2 text-[8px] opacity-75"><span className="truncate font-mono">证据引用：{attachment.id} · SHA {attachment.sha256.slice(0, 12) || "待核验"}</span>{canRetry && <button type="button" onClick={(event) => onRetry(event.currentTarget)} disabled={retrying} className="shrink-0 font-semibold underline disabled:opacity-50">{retrying ? "重试中…" : "重试解析"}</button>}</div>
  </div>;
}

function isPendingResponse(value: unknown): value is { pending: true; conversationId?: string } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>)["pending"] === true);
}

const routeLabel: Record<RouteChatRoute, string> = { local: "本地采购订单", import: "进口采购订单" };
const defaultQuestions: Record<RouteChatRoute, string[]> = {
  local: ["按供应商查看采购订单", "本周到期的采购订单", "已逾期采购订单", "高风险采购订单"],
  import: ["按供应商查看采购订单", "本周到期的采购订单", "已逾期采购订单", "高风险采购订单"],
};

const assistantCapabilities: Record<RouteChatRoute, string[]> = {
  local: ["采购订单状态与详情", "供应商信息", "交付时间线", "风险与问题", "采购支出分析"],
  import: ["采购订单状态与详情", "供应商信息", "交付时间线", "风险与问题", "采购支出分析"],
};

export function RouteChat({
  route,
  mode,
  onToggleExpand,
  onClose,
}: {
  route: RouteChatRoute;
  mode: "normal" | "expanded";
  onToggleExpand: () => void;
  onClose: () => void;
}) {
  const { formatShortDateTime } = useProcurementLocale();
  const [data, setData] = useState<RouteChatPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [newConversation, setNewConversation] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);
  const sendInFlightRef = useRef(false);
  const retryAttachmentInFlightRef = useRef(false);
  const retryAttachmentKeyRef = useRef<{ attachmentId: string; key: string } | null>(null);
  const [retryingAttachmentId, setRetryingAttachmentId] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const response = await apiRequest<unknown>(`/api/procurement/route-chat?route=${encodeURIComponent(route)}`, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setData(normalizeRouteChatPayload(response, route));
        setError(null);
        setNewConversation(false);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(routeChatErrorMessage(cause));
    } finally {
      if (!controller.signal.aborted) { setLoading(false); setRefreshing(false); }
    }
  }, [route]);

  useEffect(() => {
    setData(null); setError(null); setNotice(null); setMessage(""); setFile(null); setNewConversation(false); idempotencyKeyRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = "";
    void load();
    return () => requestRef.current?.abort();
  }, [load]);

  const hasPendingAttachment = data?.messages.some((entry) => entry.attachment && routeChatAttachmentState(entry.attachment) === "pending") === true;
  useEffect(() => {
    if (!hasPendingAttachment) return;
    const timer = window.setInterval(() => void load(true), 30_000);
    return () => window.clearInterval(timer);
  }, [hasPendingAttachment, load]);

  useEffect(() => {
    const node = messageListRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [data?.messages.length, sending]);

  const resetIdempotency = () => { idempotencyKeyRef.current = null; };
  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0] ?? null;
    resetIdempotency(); setNotice(null);
    const accept = data?.capabilities.attachments.accept.length ? data.capabilities.attachments.accept : FALLBACK_ACCEPT;
    const maxBytes = data?.capabilities.attachments.maxBytes ?? FALLBACK_MAX_FILE_BYTES;
    const extension = selected?.name.toLowerCase().match(/\.[^.]+$/u)?.[0] ?? "";
    if (selected && !accept.includes(extension)) {
      setFile(null); event.target.value = ""; setError(`路线助手仅支持 ${accept.join("、")} 文件。`); return;
    }
    if (selected && selected.size > maxBytes) {
      setFile(null); event.target.value = ""; setError(`单个聊天附件不能超过 ${formatBytes(maxBytes)}。`); return;
    }
    setFile(selected); setError(null);
  };

  const removeSelectedFile = () => {
    setFile(null); resetIdempotency();
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const retryAttachment = async (attachmentId: string, trigger?: HTMLButtonElement) => {
    if (retryAttachmentInFlightRef.current || data?.permissions.operate !== true) return;
    if (trigger) trigger.disabled = true;
    const retained = retryAttachmentKeyRef.current;
    const key = retained?.attachmentId === attachmentId
      ? retained.key
      : `route-chat-attachment-retry:${attachmentId}:${crypto.randomUUID()}`;
    retryAttachmentKeyRef.current = { attachmentId, key };
    retryAttachmentInFlightRef.current = true;
    setRetryingAttachmentId(attachmentId); setError(null); setNotice(null);
    try {
      await apiRequest(`/api/procurement/attachments/${encodeURIComponent(attachmentId)}/retry`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
      });
      if (retryAttachmentKeyRef.current?.key === key) retryAttachmentKeyRef.current = null;
      setNotice("附件已重新排入解析队列；通过安全与解析门禁后才会进入模型上下文。 ");
      await load(true);
    } catch (cause) {
      const status = cause && typeof cause === "object" && "status" in cause ? Number((cause as { status?: unknown }).status) : 0;
      if (![0, 408, 500, 503].includes(status) && retryAttachmentKeyRef.current?.key === key) retryAttachmentKeyRef.current = null;
      setError(routeChatErrorMessage(cause));
    } finally {
      retryAttachmentInFlightRef.current = false;
      setRetryingAttachmentId(null);
      if (trigger) trigger.disabled = false;
    }
  };
  const startNewConversation = () => {
    if (sendInFlightRef.current || loading || data?.permissions.operate !== true) return;
    resetIdempotency(); setMessage(""); removeSelectedFile(); setNotice(null); setError(null); setNewConversation(true);
    setData((current) => current ? { ...current, conversation: null, messages: [], suggestedQuestions: [] } : current);
  };
  const sendMessage = async (messageValue: string) => {
    const content = messageValue.trim();
    if (!content || sendInFlightRef.current || data?.permissions.operate !== true || data?.conversation?.status === "archived") return;
    if (file && !(data?.capabilities.attachments.supported === true && data.capabilities.attachments.multipart)) {
      setError(data?.capabilities.attachments.reason ?? "附件能力尚未就绪，请刷新路线助手后重试。");
      return;
    }
    sendInFlightRef.current = true;
    setSending(true); setError(null); setNotice(null);
    idempotencyKeyRef.current ??= `route-chat:${route}:${crypto.randomUUID()}`;
    try {
      const history = newConversation ? [] : (data?.messages ?? []).map((entry) => ({ role: entry.role, content: entry.content }));
      const body = file && data?.capabilities.attachments.supported && data.capabilities.attachments.multipart
        ? (() => {
            const form = new FormData();
            form.set("route", route); form.set("message", content); form.set("startNew", String(newConversation));
            form.set("expectedVersion", String(newConversation ? 0 : (data?.conversation?.version ?? 0)));
            if (!newConversation && data?.conversation?.id) form.set("conversationId", data.conversation.id);
            form.set("history", JSON.stringify(history)); form.set(data.capabilities.attachments.field, file);
            return form;
          })()
        : {
            route,
            message: content,
            startNew: newConversation,
            expectedVersion: newConversation ? 0 : (data?.conversation?.version ?? 0),
            ...(newConversation || !data?.conversation?.id ? {} : { conversationId: data.conversation.id }),
            history,
          };
      const response = await apiRequest<unknown>("/api/procurement/route-chat", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKeyRef.current },
        body,
        timeoutMs: 90_000,
      });
      if (isPendingResponse(response)) {
        setNotice("消息已持久化，AI 回答仍在生成；页面会继续读取结果。");
        removeSelectedFile();
        window.setTimeout(() => void load(true), 2_000);
      } else {
        setData(normalizeRouteChatPayload(response, route)); setMessage(""); setNewConversation(false); removeSelectedFile(); idempotencyKeyRef.current = null;
      }
    } catch (cause) {
      setError(routeChatErrorMessage(cause));
      const status = cause && typeof cause === "object" && "status" in cause ? Number((cause as { status?: unknown }).status) : 0;
      if (![0, 408, 500, 503].includes(status)) idempotencyKeyRef.current = null;
      if (status === 409 || status === 408 || status === 0) await load(true);
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void sendMessage(message);
  };

  const questions = useMemo(() => {
    const serverQuestions = data?.suggestedQuestions ?? [];
    return [...new Set([...serverQuestions, ...defaultQuestions[route]])].slice(0, 4);
  }, [data?.suggestedQuestions, route]);
  const title = routeLabel[route];
  const attachmentSupported = data?.capabilities.attachments.supported === true && data.capabilities.attachments.multipart;
  const attachmentAccept = data?.capabilities.attachments.accept.length ? data.capabilities.attachments.accept.join(",") : FALLBACK_ACCEPT.join(",");

  return <section aria-label={`${title} Readywork 助理`} className="min-h-0 flex flex-1 flex-col overflow-hidden">
    <div className="flex items-center gap-3 border-b border-[#e9edf2] px-5 py-4">
      <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-[#2563eb] to-[#1746a2] text-white shadow-sm"><Sparkles className="size-4" /></span>
      <div className="min-w-0 flex-1"><div className="text-sm font-bold text-[#1f2a3d]">Readywork 助理</div><div className="mt-0.5 text-[10px] text-[#9199a6]">欢迎询问您的{title}</div></div>
      <button type="button" aria-label={mode === "expanded" ? "收起面板" : "展开面板"} onClick={onToggleExpand} className="flex size-8 items-center justify-center rounded-lg text-[#7f8998] hover:bg-[#f3f5f8]">{mode === "expanded" ? <Shrink className="size-3.5" /> : <Expand className="size-3.5" />}</button>
      {data?.permissions.operate === true && <button type="button" aria-label="新建对话" onClick={startNewConversation} disabled={sending || loading} className="flex size-8 items-center justify-center rounded-lg text-[#7f8998] hover:bg-[#f3f5f8] disabled:opacity-40"><MessageSquarePlus className="size-3.5" /></button>}
      <button type="button" aria-label="关闭助理" onClick={onClose} className="flex size-8 items-center justify-center rounded-lg text-[#7f8998] hover:bg-[#f3f5f8]"><PanelLeftClose className="size-3.5" /></button>
    </div>

    {loading ? <div className="flex min-h-[330px] items-center justify-center text-xs text-slate-400"><Loader2 className="mr-2 size-4 animate-spin" />读取持久化路线会话…</div> : <>
      {error && <div role="alert" className="mx-5 mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-[10px] leading-5 text-red-700"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{error}</div>}
      {notice && <div role="status" className="mx-5 mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[10px] leading-5 text-amber-800">{notice}</div>}
      <div className="border-b border-[#edf0f4] bg-white px-4 py-4">
        <div className="rounded-2xl bg-[#f7f8ff] px-4 py-4"><div className="text-sm font-bold text-[#26364f]">您好！👋</div>
          <p className="mt-1.5 text-[11px] leading-5 text-[#66758b]">我是 Readywork 助理。欢迎询问与您的{route === "local" ? "本地" : "进口"}采购订单有关的任何问题。我可以帮您了解：</p>
          <ul className="mt-3 space-y-1.5 text-[10px] leading-4 text-[#768092]">{assistantCapabilities[route].map((capability) => <li key={capability} className="flex items-start gap-2"><span className="mt-[5px] size-1 shrink-0 rounded-full bg-[#8d98aa]" />{capability}</li>)}</ul>
        </div>
        {data?.permissions.operate === true ? <div className="mt-4 grid gap-2 sm:grid-cols-2">{questions.map((question) => <button data-preserve-language key={question} type="button" onClick={() => { resetIdempotency(); void sendMessage(question); }} disabled={sending} className="rounded-lg border border-[#dfe6ef] bg-white px-3 py-2 text-left text-[9px] font-medium leading-4 text-[#52627a] transition hover:border-blue-300 hover:text-blue-700 disabled:opacity-50">{question}</button>)}</div> : <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[10px] leading-5 text-amber-800">当前身份只有读取权限；可以查看已持久化对话，但不能新建、重试附件或发送消息。</div>}
      </div>
      <div ref={messageListRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        {!data?.messages.length ? <div aria-label="暂无对话消息" className="min-h-[120px]" /> : data.messages.map((entry) => {
          const assistant = entry.role === "assistant";
          return <article key={entry.id} className={cn("flex gap-2", assistant ? "justify-start" : "justify-end")}><span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg", assistant ? "bg-[#0b1b3c] text-white" : "order-2 bg-[#dfe7e2] text-[#17634f]")}>{assistant ? <Bot className="size-3" /> : <UserRound className="size-3" />}</span><div className={cn("min-w-0 max-w-[88%] rounded-2xl px-3 py-2.5", assistant ? entry.status === "failed" ? "border border-amber-200 bg-amber-50" : "border border-[#dfe6ef] bg-white" : "bg-[#17634f] text-white")}><div data-preserve-language className={cn("whitespace-pre-wrap break-words text-[10px] leading-5", assistant ? "text-[#40516a]" : "text-white")}>{entry.content}</div>{entry.attachment && <AttachmentStatus attachment={entry.attachment} retrying={retryingAttachmentId === entry.attachment.id} onRetry={(trigger) => void retryAttachment(entry.attachment!.id, trigger)} canMutate={data?.permissions.operate === true} />}<div className={cn("mt-1.5 flex flex-wrap items-center gap-1.5 text-[8px]", assistant ? "text-[#9aa5b4]" : "text-white/70")}><span>{formatShortDateTime(entry.createdAt || null, "时间未记录")}</span>{assistant && <span>· {entry.modelRoute === "reasoning" ? "推理" : entry.modelRoute === "fast" ? "快速" : "模型"}</span>}</div></div></article>;
        })}
        {sending && <div className="flex items-center gap-2"><span className="flex size-6 items-center justify-center rounded-lg bg-[#0b1b3c] text-white"><Bot className="size-3" /></span><div className="rounded-2xl border border-[#dfe6ef] bg-white px-3 py-2.5 text-[10px] text-[#718198]"><Loader2 className="mr-1.5 inline size-3 animate-spin" />正在读取路线事实并生成回答…</div></div>}
      </div>
      {data?.permissions.operate === true && <form onSubmit={(event) => void submit(event)} className="bg-white px-4 py-4">{file && <div className="mb-2 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-2 text-[9px] text-blue-800"><Paperclip className="size-3 shrink-0" /><span className="min-w-0 flex-1 truncate">{file.name} · {formatBytes(file.size)} · 等待发送</span><button type="button" aria-label="移除待发送附件" onClick={removeSelectedFile} className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-blue-100"><X className="size-3" /></button></div>}<div className="flex items-center gap-2 rounded-2xl border border-[#d9e2ee] bg-white p-2 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100"><input type="text" value={message} onChange={(event) => { setMessage(event.target.value); resetIdempotency(); }} disabled={sending || data?.conversation?.status === "archived"} maxLength={4000} placeholder={`询问关于${route === "local" ? "本地" : "进口"}采购订单的问题…`} className="min-w-0 flex-1 bg-transparent px-1 text-[10px] leading-5 text-[#26364f] outline-none placeholder:text-[#a0a9b6] disabled:cursor-not-allowed" /><input ref={fileInputRef} type="file" accept={attachmentAccept} onChange={selectFile} className="sr-only" /><button type="button" disabled={!attachmentSupported || sending} onClick={() => fileInputRef.current?.click()} title={data?.capabilities.attachments.reason ?? "选择 PDF、CSV、XLSX、DOCX、TXT 或 MD 文件"} aria-label="添加附件" className="flex size-7 items-center justify-center rounded-lg text-[#6f7f96] hover:bg-[#f5f8fc] disabled:cursor-not-allowed disabled:opacity-50"><Paperclip className="size-3" /></button><button type="submit" aria-label="发送" title="发送" disabled={sending || !message.trim() || data?.conversation?.status === "archived"} className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#a9b8ee] text-white hover:bg-[#88a0eb] disabled:cursor-not-allowed disabled:opacity-60">{sending ? <Loader2 className="size-3 animate-spin" /> : <Send className="size-3" />}</button></div><p className="mt-2 text-center text-[8px] leading-4 text-[#8795a8]">Readywork 助理可能出错，请核对重要信息。</p><button type="button" onClick={() => void load(true)} disabled={refreshing || sending} className="sr-only">刷新历史</button></form>}
    </>}
  </section>;
}
