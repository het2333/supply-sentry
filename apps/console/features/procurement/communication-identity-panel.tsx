"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Clock3, Loader2, Save, ShieldCheck, UserRound } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";

type Identity = {
  displayName: string;
  title: string;
  organizationName: string;
  status: "active" | "disabled";
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};
type IdentityEvent = { id: string; actorId: string; action: string; detail: Record<string, unknown>; createdAt: string };
type IdentityResponse = {
  item: Identity | null;
  readiness: "ready" | "missing";
  suggested: { displayName?: string; title?: string };
  permissions: { read: boolean; configure: boolean };
  legacyDrafts: {
    withoutIdentity: number;
    eligibleForRebind: number;
    requiresManualReview: number;
    reboundInThisWrite: number;
  };
  events: IdentityEvent[];
};

function errorText(error: unknown): string {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 409) return "保存失败：配置已被其他人更新，请重新读取后再保存。";
    if (error.status === 403) return "当前账号没有配置采购沟通身份的权限。";
    return error.message;
  }
  return error instanceof Error ? error.message : "采购沟通身份请求失败";
}

/** 采购外发的真实发件人设置；保存结果由后端租户级持久化并审计。 */
export function ProcurementCommunicationIdentityPanel() {
  const { formatDateTime: formatTime } = useProcurementLocale();
  const [data, setData] = useState<IdentityResponse | null>(null);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [organization, setOrganization] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRequest<IdentityResponse>("/api/procurement/communication-identity");
      setData(result);
      setName(result.item?.displayName ?? "");
      setTitle(result.item?.title ?? "");
      setOrganization(result.item?.organizationName ?? "");
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (!data?.permissions.configure || saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiRequest<IdentityResponse>("/api/procurement/communication-identity", {
        method: "PUT",
        body: {
          expectedVersion: data.item?.version ?? 0,
          displayName: name,
          title,
          organizationName: organization,
        },
      });
      setData(result);
      setName(result.item?.displayName ?? name.trim());
      setTitle(result.item?.title ?? title.trim());
      setOrganization(result.item?.organizationName ?? organization.trim());
      setNotice(result.legacyDrafts.reboundInThisWrite > 0
        ? `采购沟通身份已保存；同时安全修复 ${result.legacyDrafts.reboundInThisWrite} 份未编辑旧草稿，已保留审计。`
        : "采购沟通身份已保存；后续外发会使用该具名联系人。");
    } catch (requestError) {
      setError(errorText(requestError));
      if (requestError instanceof ReadyworkApiError && requestError.status === 409) await load();
    } finally {
      setSaving(false);
    }
  }

  const ready = data?.readiness === "ready" && data.item?.status === "active";
  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>供应商可见的专业联系人</CardTitle>
            <Badge tone={ready ? "green" : "amber"}>{loading ? "读取中…" : ready ? "已配置" : "未配置"}</Badge>
          </div>
          <CardDescription>采购邮件以真实采购联系人身份沟通，供应商不会看到 Readywork 或 AI 标识。</CardDescription>
        </div>
        <UserRound className="size-5 shrink-0 text-slate-400" />
      </CardHeader>
      <CardContent className="pt-4">
        {loading ? (
          <div className="flex items-center gap-2 py-5 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" />正在读取采购沟通身份…</div>
        ) : (
          <>
            {!ready && <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>尚未配置专业联系人；为避免冒充或泄露 AI 身份，外部沟通生成与发送已阻断。</span></div>}
            {data?.legacyDrafts.eligibleForRebind ? <div className="mb-4 flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-xs leading-5 text-blue-800"><ShieldCheck className="mt-0.5 size-4 shrink-0" /><span>保存后会仅为 {data.legacyDrafts.eligibleForRebind} 份未编辑、仍待审的旧 SLA 草稿替换专业签名并写入追加审计；已编辑或已处理草稿不会被改写。</span></div> : null}
            {data?.legacyDrafts.requiresManualReview ? <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>仍有 {data.legacyDrafts.requiresManualReview} 份缺少身份快照的草稿已有人工修改或无法验证来源，系统不会自动重写，需丢弃后重新生成。</span></div> : null}
            {error && <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}
            {notice && <div role="status" className="mb-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs leading-5 text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</div>}
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block text-xs font-medium text-slate-600">联系人姓名<input value={name} onChange={(event) => setName(event.target.value)} disabled={!data?.permissions.configure || saving} placeholder={data?.suggested.displayName || "例如：张敏"} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-900 outline-none transition focus:border-blue-400 disabled:bg-slate-50 disabled:text-slate-400" /></label>
              <label className="block text-xs font-medium text-slate-600">职位<input value={title} onChange={(event) => setTitle(event.target.value)} disabled={!data?.permissions.configure || saving} placeholder={data?.suggested.title || "例如：采购经理"} className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-900 outline-none transition focus:border-blue-400 disabled:bg-slate-50 disabled:text-slate-400" /></label>
              <label className="block text-xs font-medium text-slate-600">公司名称<input value={organization} onChange={(event) => setOrganization(event.target.value)} disabled={!data?.permissions.configure || saving} placeholder="例如：Readywork 制造有限公司" className="mt-1.5 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-normal text-slate-900 outline-none transition focus:border-blue-400 disabled:bg-slate-50 disabled:text-slate-400" /></label>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
                <span className="flex items-center gap-1"><ShieldCheck className="size-3.5 text-slate-500" />正文与 SMTP 发件名使用上述身份</span>
                {data?.item && <span className="flex items-center gap-1"><Clock3 className="size-3.5" />最近修改：{data.item.updatedBy} · {formatTime(data.item.updatedAt)} · v{data.item.version}</span>}
              </div>
              {data?.permissions.configure && <button type="button" onClick={() => void save()} disabled={saving || !name.trim() || !title.trim() || !organization.trim()} className="flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-semibold text-white shadow-sm shadow-blue-100 transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"><Save className="size-4" />{saving ? "保存中…" : "保存联系人"}</button>}
            </div>
            {data?.events?.length ? <div className="mt-4 text-[11px] text-slate-400">最近审计：{data.events[0]?.action === "created" ? "首次配置" : "更新配置"} · {formatTime(data.events[0]?.createdAt)}</div> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
