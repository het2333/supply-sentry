"use client";

import { type FormEvent, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Loader2 } from "lucide-react";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";

type SubmissionState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; requestId: string }
  | { kind: "error"; message: string };

type DemoResponse = {
  accepted: true;
  requestId: string;
  submittedAt: string;
  replayed: boolean;
};

function errorMessage(error: unknown): string {
  if (error instanceof ReadyworkApiError) return error.message;
  return "申请未能保存，请稍后重试。";
}

export function DemoRequestForm() {
  const [state, setState] = useState<SubmissionState>({ kind: "idle" });
  const idempotencyKey = useRef<string | null>(null);
  const submissionInFlight = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionInFlight.current) return;
    submissionInFlight.current = true;
    const form = event.currentTarget;
    const values = new FormData(form);
    idempotencyKey.current ??= `readywork-demo:${window.crypto.randomUUID()}`;
    setState({ kind: "submitting" });
    try {
      const result = await apiRequest<DemoResponse>("/api/public/demo-requests", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey.current },
        body: {
          fullName: values.get("fullName"),
          email: values.get("email"),
          company: values.get("company"),
          role: values.get("role"),
          country: values.get("country"),
          erp: values.get("erp"),
          poVolume: values.get("poVolume"),
          message: values.get("message"),
          website: values.get("website"),
        },
      });
      setState({ kind: "success", requestId: result.requestId });
      form.reset();
      idempotencyKey.current = null;
    } catch (error) {
      setState({ kind: "error", message: errorMessage(error) });
    } finally {
      submissionInFlight.current = false;
    }
  }

  if (state.kind === "success") {
    return <div className="rounded-2xl border border-[#d9e2ef] bg-[#f3f6fa] p-7" role="status">
      <CheckCircle2 className="size-7 text-blue-600" />
      <h3 className="mt-5 text-xl font-semibold tracking-[-0.02em] text-[#0b1220]">您的申请已保存。</h3>
      <p className="mt-2 max-w-lg text-sm leading-6 text-[#617087]">申请已保存，将由人工跟进。系统未自动发送外部邮件，也未执行 CRM 操作。</p>
      <p className="mt-4 break-all font-mono text-[11px] text-[#78869b]">参考编号：{state.requestId}</p>
      <button type="button" onClick={() => setState({ kind: "idle" })} className="mt-6 text-sm font-semibold text-[#1f4f9c] underline decoration-[#a9bfdf] underline-offset-4">再提交一份申请</button>
    </div>;
  }

  const field = "h-11 w-full rounded-[6px] border border-[rgba(15,27,51,.14)] bg-[#fafbfd] px-3.5 !text-[14px] !font-normal !leading-normal tracking-normal text-[#0b1220] outline-none transition placeholder:text-[#98a3b5] focus:border-[#7fa5da] focus:ring-4 focus:ring-[#e7eef9]";
  const label = "mb-1.5 block text-[13px] font-medium text-[#46536b]";
  return <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-[18px]">
    <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" className="absolute -left-[9999px] h-px w-px opacity-0" />
    <div className="grid grid-cols-2 gap-[18px]">
      <div><label htmlFor="demo-fullName" className={label}>姓名 *</label><input id="demo-fullName" name="fullName" required minLength={2} maxLength={120} placeholder="例如：张伟" className={field} /></div>
      <div><label htmlFor="demo-email" className={label}>工作邮箱 *</label><input id="demo-email" name="email" type="email" required maxLength={254} placeholder="name@company.com" className={field} /></div>
    </div>
    <div className="grid grid-cols-2 gap-[18px]">
      <div><label htmlFor="demo-company" className={label}>公司 *</label><input id="demo-company" name="company" required minLength={2} maxLength={160} placeholder="公司名称" className={field} /></div>
      <div><label htmlFor="demo-role" className={label}>职位</label><input id="demo-role" name="role" maxLength={120} placeholder="例如：采购负责人" className={field} /></div>
    </div>
    <div className="grid grid-cols-2 gap-[18px]">
      <div><label htmlFor="demo-country" className={label}>国家或地区</label><input id="demo-country" name="country" maxLength={120} placeholder="例如：中国" className={field} /></div>
      <div><label htmlFor="demo-erp" className={label}>ERP 系统</label><select id="demo-erp" name="erp" defaultValue="" className={`${field} pr-9`}><option value="">请选择…</option><option value="sap">SAP</option><option value="quickbooks">QuickBooks</option><option value="other">其他</option><option value="none">未使用 ERP</option></select></div>
    </div>
    <div><label htmlFor="demo-poVolume" className={label}>每月采购订单数量</label><select id="demo-poVolume" name="poVolume" defaultValue="" className={`${field} pr-9`}><option value="">请选择…</option><option value="lt100">100 张以下</option><option value="100-500">100 至 500 张</option><option value="gt500">500 张以上</option></select></div>
    <div><label htmlFor="demo-message" className={label}>试点需要覆盖什么？（选填）</label><textarea id="demo-message" name="message" rows={4} maxLength={2000} placeholder="例如：选定的一组采购订单、某个供应商区域或进口路线…" className={`${field} h-[94px] resize-y py-2.5`} /></div>
    {state.kind === "error" ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{state.message}</div> : null}
    <button type="submit" disabled={state.kind === "submitting"} className="mt-1 inline-flex h-12 self-start items-center gap-2 rounded-[10px] border border-transparent bg-[#0b1220] px-[22px] text-[15px] !font-medium tracking-[-0.005em] text-[#fafbfd] transition hover:bg-[#18243a] disabled:cursor-not-allowed disabled:opacity-60">
      {state.kind === "submitting" ? <><Loader2 className="size-4 animate-spin" />正在保存申请…</> : <>申请演示<ArrowRight className="size-4" /></>}
    </button>
    <p className="-mt-1.5 text-[12.5px] leading-[1.5] text-[#66738a]">无需承诺。只有保存成功后才会显示成功状态；此表单不会触发供应商或 ERP 操作。</p>
  </form>;
}
