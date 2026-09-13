"use client";

import { uiConfirm } from "@/features/localization/ui-dialogs";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, BellRing, CalendarDays, CheckCircle2, Clock3, Factory, Globe2, History, Loader2, RefreshCw, Save, Umbrella } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import {
  useProcurementLocale,
  useProcurementTenantPreferences,
  type ProcurementDateFormat as DateFormat,
  type ProcurementTenantPreferencesResponse as PreferencesResponse,
} from "@/features/procurement/tenant-preferences-context";
import { cn } from "@/lib/utils";

const weekdays = [
  { id: 1, label: "周一" }, { id: 2, label: "周二" }, { id: 3, label: "周三" },
  { id: 4, label: "周四" }, { id: 5, label: "周五" }, { id: 6, label: "周六" }, { id: 7, label: "周日" },
];
const countries = [
  { id: "CN", label: "中国" }, { id: "SG", label: "新加坡" }, { id: "JP", label: "日本" },
  { id: "GB", label: "英国" }, { id: "DE", label: "德国" }, { id: "US", label: "美国" },
];
const timeZones = [
  "Asia/Shanghai", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles",
];
const dateFormats: DateFormat[] = ["DD MMM YYYY", "MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"];
const referenceWeekdays = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const countryNames: Record<string, string> = { CN: "中国", SG: "新加坡", JP: "日本", GB: "英国", DE: "德国", US: "美国" };
const timeZoneNames: Record<string, string> = {
  "Asia/Shanghai": "(GMT+08:00) 北京、重庆、香港、乌鲁木齐",
  "Asia/Singapore": "(GMT+08:00) 新加坡、吉隆坡",
  "Asia/Tokyo": "(GMT+09:00) 东京、大阪",
  "Europe/London": "(GMT+00:00) UTC、伦敦",
  "Europe/Berlin": "(GMT+01:00) 柏林、阿姆斯特丹、罗马",
  "America/New_York": "(GMT-05:00) 纽约",
  "America/Los_Angeles": "(GMT-08:00) 洛杉矶",
};

function errorText(error: unknown, action: boolean): string {
  if (error instanceof ReadyworkApiError) {
    if (action && error.status === 409) {
      const payload = error.payload as { currentVersion?: unknown } | undefined;
      const version = typeof payload?.currentVersion === "number" ? `服务端版本为 v${payload.currentVersion}。` : "";
      return `区域偏好已被其他人更新，已保留您的输入。${version}请重新读取并核对最新配置后再保存。`;
    }
    if (error.status === 403) return action ? "当前账号没有修改租户区域偏好的权限，输入已保留。请联系管理员并重新读取权限。" : "当前账号没有读取租户区域偏好的权限，请联系管理员。";
    if (action && uncertainSave(error)) return "保存结果尚未确认，输入已保留。请先重新读取服务端配置核对结果，不要重复提交。";
    return error.message;
  }
  return error instanceof Error ? error.message : "采购区域偏好请求失败";
}

function uncertainSave(error: unknown): boolean {
  return !(error instanceof ReadyworkApiError) || error.status === 0 || error.status === 408 || error.status === 499 || error.status >= 500;
}

export type ProcurementPreferencesSaveState = { disabled: boolean; saving: boolean };

function dateExample(format: DateFormat): string {
  if (format === "DD MMM YYYY") return "30 8月 2026";
  if (format === "DD/MM/YYYY") return "30/08/2026";
  if (format === "MM/DD/YYYY") return "08/30/2026";
  return "2026-08-30";
}

function PolicyToggle({
  label,
  description,
  checked,
  onChange,
  disabled,
  Icon,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
  Icon: typeof BellRing;
}) {
  return <div className="flex min-h-[92px] items-center justify-between gap-5 border-b border-[#edf0f4] px-5 py-4 odd:border-r">
    <span className="flex min-w-0 items-start gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#eef4ff] text-[#2563eb]"><Icon className="size-4" /></span>
      <span className="min-w-0"><span className="block text-[13px] font-bold text-[#253047]">{label}</span><span className="mt-1 block max-w-[470px] text-[11px] leading-[18px] text-[#778195]">{description}</span></span>
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn("relative h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-[#2f6fed]" : "bg-[#cbd3df]", disabled && "cursor-not-allowed opacity-50")}
    >
      <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  </div>;
}

function ReferenceToggle({ label, description, checked, onChange, disabled }: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled: boolean;
}) {
  return <div className="flex min-h-[60px] items-start justify-between gap-5">
    <span className="min-w-0"><span className="block text-[13px] font-semibold text-[#253047]">{label}</span><span className="mt-1 block text-[11px] leading-[17px] text-[#778195]">{description}</span></span>
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} className={cn("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-[#3567e9]" : "bg-[#d8dee8]", disabled && "cursor-not-allowed opacity-50")}>
      <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform", checked ? "translate-x-5" : "translate-x-0.5")} />
    </button>
  </div>;
}

export function ProcurementTenantPreferencesPanel({ referenceLayout = false, onSaveStateChange }: { referenceLayout?: boolean; onSaveStateChange?: (state: ProcurementPreferencesSaveState) => void } = {}) {
  const { response: data, loading, error: loadError, refresh: load, acceptResponse } = useProcurementTenantPreferences();
  const { formatDateTime } = useProcurementLocale();
  const [countryCode, setCountryCode] = useState("CN");
  const [workingDays, setWorkingDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [dateFormat, setDateFormat] = useState<DateFormat>("DD MMM YYYY");
  const [slaEscalationsEnabled, setSlaEscalationsEnabled] = useState(true);
  const [excludeWeekends, setExcludeWeekends] = useState(true);
  const [excludePublicHolidays, setExcludePublicHolidays] = useState(true);
  const [autoCalculateLeadTime, setAutoCalculateLeadTime] = useState(true);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const saveInFlight = useRef(false);

  useEffect(() => {
    if (!data) return;
    setCountryCode(data.effective.countryCode);
    setWorkingDays(data.effective.workingDays);
    setTimeZone(data.effective.timeZone);
    setDateFormat(data.effective.dateFormat);
    setSlaEscalationsEnabled(data.effective.slaEscalationsEnabled);
    setExcludeWeekends(data.effective.excludeWeekends);
    setExcludePublicHolidays(data.effective.excludePublicHolidays);
    setAutoCalculateLeadTime(data.effective.autoCalculateLeadTime);
  }, [data]);

  const dirty = useMemo(() => {
    if (!data) return false;
    const effective = data.effective;
    return data.inheritedDefault
      || countryCode !== effective.countryCode
      || timeZone !== effective.timeZone
      || dateFormat !== effective.dateFormat
      || slaEscalationsEnabled !== effective.slaEscalationsEnabled
      || excludeWeekends !== effective.excludeWeekends
      || excludePublicHolidays !== effective.excludePublicHolidays
      || autoCalculateLeadTime !== effective.autoCalculateLeadTime
      || JSON.stringify([...workingDays].sort()) !== JSON.stringify([...effective.workingDays].sort());
  }, [autoCalculateLeadTime, countryCode, data, dateFormat, excludePublicHolidays, excludeWeekends, slaEscalationsEnabled, timeZone, workingDays]);

  const requiresReload = Boolean(actionError) && (uncertainSave(actionError) || (actionError instanceof ReadyworkApiError && [401, 403, 409].includes(actionError.status)));
  const saveDisabled = !data?.permissions.configure || loading || Boolean(loadError) || saving || !dirty || requiresReload || (!referenceLayout && reason.trim().length < 10);
  useEffect(() => { onSaveStateChange?.({ disabled: saveDisabled, saving }); }, [onSaveStateChange, saveDisabled, saving]);

  const toggleWorkingDay = (day: number) => {
    setNotice(null);
    setWorkingDays((current) => current.includes(day)
      ? current.length === 1 ? current : current.filter((item) => item !== day)
      : [...current, day].sort((left, right) => left - right));
  };

  const toggleExcludeWeekends = (next: boolean) => {
    setNotice(null);
    setExcludeWeekends(next);
    if (next) setWorkingDays((current) => {
      const weekdaysOnly = current.filter((day) => day <= 5);
      return weekdaysOnly.length ? weekdaysOnly : [1, 2, 3, 4, 5];
    });
  };

  async function save() {
    const resolvedReason = referenceLayout ? "通过配置页面更新常规设置。" : reason.trim();
    if (!data || saveInFlight.current || saveDisabled) return;
    if (!referenceLayout && !uiConfirm("确认更新常规设置？\n\n变更会版本化并写入审计；会影响后续 SLA 自动升级、工作日/节假日计算和制造交期风险，不会改写既有业务时间戳或历史快照。")) return;
    saveInFlight.current = true;
    setSaving(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await apiRequest<PreferencesResponse>("/api/procurement/tenant-preferences", {
        method: "PUT",
        body: {
          expectedVersion: data.item?.version ?? 0,
          countryCode,
          workingDays,
          timeZone,
          dateFormat,
          slaEscalationsEnabled,
          excludeWeekends,
          excludePublicHolidays,
          autoCalculateLeadTime,
          reason: resolvedReason,
        },
      });
      acceptResponse(response);
      setReason("");
      setNotice("常规设置已保存；新策略会用于后续 SLA Worker、业务日历和交期风险计算，历史证据不会被改写。");
    } catch (requestError) {
      setActionError(requestError);
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  }

  const errorNotice = (actionError ?? loadError) ? <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700"><span className="flex items-start gap-2"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{loadError && data ? <span className="block">最新配置读取失败，仍保留上次成功读取的配置和未保存输入，暂不可保存。</span> : null}<span data-preserve-language>{errorText(actionError ?? loadError, Boolean(actionError))}</span></span></span><button type="button" disabled={saving || loading} onClick={() => { if (saveInFlight.current) return; setActionError(null); setNotice(null); void load(); }} className="flex shrink-0 items-center gap-1 font-semibold hover:underline disabled:opacity-50"><RefreshCw className="size-3.5" />{data && dirty ? "放弃未保存输入并重新读取" : "重新读取"}</button></div> : null;

  return <Card id="tenant-preferences" className="scroll-mt-24 overflow-hidden">
    {!referenceLayout && <CardHeader>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2"><CardTitle>运行策略与业务日历</CardTitle><Badge tone={!data ? "neutral" : data.inheritedDefault ? "amber" : "green"}>{loading ? "读取中…" : !data ? "未读取" : data.inheritedDefault ? "沿用默认" : `v${data.item?.version}`}</Badge></div>
        <CardDescription>这些开关直接控制后续自动化和计算；每次保存均采用乐观锁并写入租户审计。</CardDescription>
      </div>
      <Globe2 className="size-5 shrink-0 text-slate-400" />
    </CardHeader>}
    <form id="tenant-preferences-form" aria-busy={saving || loading} onSubmit={(event) => { event.preventDefault(); void save(); }}>
    <CardContent className="space-y-5 pt-4">
      {loading ? <div className="flex items-center gap-2 py-6 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" />正在读取租户偏好…</div> : !data ? errorNotice : referenceLayout ? <>
        {errorNotice}
        {!data.permissions.configure && <p className="text-xs text-slate-500">当前为只读配置；修改权限由采购经理或管理员管理。</p>}
        {notice && <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs leading-5 text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />更改已保存到权威租户配置。</div>}
        <div className="grid gap-x-10 gap-y-5 lg:grid-cols-2">
          <div className="space-y-5">
            <label className="block text-[13px] font-semibold text-[#253047]">国家
              <select value={countryCode} onChange={(event) => { setCountryCode(event.target.value); setNotice(null); }} disabled={!data?.permissions.configure || saving} className="mt-2 h-11 w-full rounded-xl border border-[#e2e7ef] bg-white px-3 text-sm font-normal text-[#273247] outline-none focus:border-blue-400 disabled:bg-slate-50">{countries.map((country) => <option key={country.id} value={country.id}>{countryNames[country.id] ?? country.label}</option>)}</select>
              <span className="mt-1.5 block text-[11px] font-normal text-[#8a94a6]">选择日历和节假日配置的默认国家。</span>
            </label>
            <fieldset disabled={!data?.permissions.configure || saving}>
              <legend className="text-[13px] font-semibold text-[#253047]">工作日</legend>
              <div className="mt-2 flex flex-wrap gap-2">{referenceWeekdays.map((label, index) => { const day = index + 1; const locked = excludeWeekends && day >= 6; const selected = !locked && workingDays.includes(day); return <button key={label} type="button" aria-pressed={selected} disabled={locked} onClick={() => toggleWorkingDay(day)} className={cn("h-9 rounded-xl border px-3 text-xs font-medium transition", selected ? "border-[#b8c6ef] bg-[#f4f6ff] text-[#34466f]" : "border-[#e5e9f0] bg-white text-[#697386]", locked && "cursor-not-allowed bg-[#f7f8fa] text-[#c8ced7]")}>{selected ? "✓ " : ""}{label}</button>; })}</div>
              <p className="mt-2 text-[11px] leading-5 text-[#8a94a6]">选择服务等级和交期计算使用的工作日。</p>
            </fieldset>
            <ReferenceToggle label="启用 SLA 升级" description="超过 SLA 阈值时启用升级规则。" checked={slaEscalationsEnabled} onChange={(next) => { setSlaEscalationsEnabled(next); setNotice(null); }} disabled={!data?.permissions.configure || saving} />
            <ReferenceToggle label="排除周末" description="服务等级和交期计算不计入周末。" checked={excludeWeekends} onChange={toggleExcludeWeekends} disabled={!data?.permissions.configure || saving} />
          </div>
          <div className="space-y-5">
            <ReferenceToggle label="排除公共节假日" description="计算时排除所选国家的公共节假日。" checked={excludePublicHolidays} onChange={(next) => { setExcludePublicHolidays(next); setNotice(null); }} disabled={!data?.permissions.configure || saving} />
            <ReferenceToggle label="自动计算交期" description="根据活跃规则自动计算并更新交期。" checked={autoCalculateLeadTime} onChange={(next) => { setAutoCalculateLeadTime(next); setNotice(null); }} disabled={!data?.permissions.configure || saving} />
            <label className="block text-[13px] font-semibold text-[#253047]">默认时区
              <select value={timeZone} onChange={(event) => { setTimeZone(event.target.value); setNotice(null); }} disabled={!data?.permissions.configure || saving} className="mt-2 h-11 w-full rounded-xl border border-[#e2e7ef] bg-white px-3 text-sm font-normal text-[#273247] outline-none focus:border-blue-400 disabled:bg-slate-50">{timeZones.map((zone) => <option key={zone} value={zone}>{timeZoneNames[zone] ?? zone}</option>)}</select>
              <span className="mt-1.5 block text-[11px] font-normal text-[#8a94a6]">所有日期和时间计算使用的时区。</span>
            </label>
            <label className="block text-[13px] font-semibold text-[#253047]">日期格式
              <select value={dateFormat} onChange={(event) => { setDateFormat(event.target.value as DateFormat); setNotice(null); }} disabled={!data?.permissions.configure || saving} className="mt-2 h-11 w-full rounded-xl border border-[#e2e7ef] bg-white px-3 text-sm font-normal text-[#273247] outline-none focus:border-blue-400 disabled:bg-slate-50">{dateFormats.map((format) => <option key={format}>{format}</option>)}</select>
              <span className="mt-1.5 block text-[11px] font-normal text-[#8a94a6]">选择应用的默认日期格式。</span>
            </label>
          </div>
        </div>
      </> : <>
        {errorNotice}
        {notice && <div role="status" className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs leading-5 text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</div>}
        {data?.inheritedDefault && <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><AlertCircle className="mt-0.5 size-4 shrink-0" />当前沿用系统默认：启用 SLA 升级、排除周末与公共节假日、自动计算制造交期；保存后才形成租户级版本和审计。</div>}

        <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-[#e2e7ef] bg-white">
          <PolicyToggle label="启用 SLA 升级" description="关闭后，SLA Worker 不领取租约、不生成催办草稿，也不会因手工强制运行而绕过该门禁。" checked={slaEscalationsEnabled} onChange={(next) => { setSlaEscalationsEnabled(next); setNotice(null); }} disabled={!data?.permissions.configure || saving} Icon={BellRing} />
          <PolicyToggle label="排除周末" description="开启后，SLA 日历会从工作日清单中排除周六和周日；关闭后按下方明确选择的工作日执行。" checked={excludeWeekends} onChange={toggleExcludeWeekends} disabled={!data?.permissions.configure || saving} Icon={CalendarDays} />
          <PolicyToggle label="排除公共节假日" description="按国家和 SLA 基准年份冻结公共节假日快照；证据包含数据源、版本、许可和实际排除日期。" checked={excludePublicHolidays} onChange={(next) => { setExcludePublicHolidays(next); setNotice(null); }} disabled={!data?.permissions.configure || saving} Icon={Umbrella} />
          <PolicyToggle label="自动计算交期" description="关闭后保留制造交期主数据，但后续风险组合不再自动套用模板或产生周期不足风险。" checked={autoCalculateLeadTime} onChange={(next) => { setAutoCalculateLeadTime(next); setNotice(null); }} disabled={!data?.permissions.configure || saving} Icon={Factory} />
        </div>
        {excludePublicHolidays && <p className="-mt-2 text-[10px] leading-5 text-[#8a94a6]">公共节假日数据：<a href="https://github.com/commenthol/date-holidays" target="_blank" rel="noreferrer" className="font-semibold text-[#61728f] underline decoration-[#cbd3df] underline-offset-2">date-holidays 3.36.0</a> · ISC / CC BY 3.0；SLA 证据冻结实际使用日期。</p>}

        <div className="grid gap-4 lg:grid-cols-3">
          <label className="rounded-2xl border border-slate-200 bg-white p-4"><span className="flex items-center gap-2 text-xs font-semibold text-slate-800"><Globe2 className="size-4 text-blue-600" />国家 / 地区</span><select value={countryCode} onChange={(event) => { setCountryCode(event.target.value); setNotice(null); }} disabled={!data?.permissions.configure || saving} className="mt-3 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-400 disabled:bg-slate-50">{countries.map((country) => <option key={country.id} value={country.id}>{country.label} · {country.id}</option>)}</select></label>
          <label className="rounded-2xl border border-slate-200 bg-white p-4"><span className="flex items-center gap-2 text-xs font-semibold text-slate-800"><Clock3 className="size-4 text-blue-600" />IANA 时区</span><select value={timeZone} onChange={(event) => { setTimeZone(event.target.value); setNotice(null); }} disabled={!data?.permissions.configure || saving} className="mt-3 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-400 disabled:bg-slate-50">{timeZones.map((zone) => <option key={zone}>{zone}</option>)}</select></label>
          <label className="rounded-2xl border border-slate-200 bg-white p-4"><span className="flex items-center gap-2 text-xs font-semibold text-slate-800"><CalendarDays className="size-4 text-blue-600" />日期格式</span><select value={dateFormat} onChange={(event) => { setDateFormat(event.target.value as DateFormat); setNotice(null); }} disabled={!data?.permissions.configure || saving} className="mt-3 h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-800 outline-none focus:border-blue-400 disabled:bg-slate-50">{dateFormats.map((format) => <option key={format}>{format}</option>)}</select><span className="mt-2 block text-[11px] text-slate-400">预览：{dateExample(dateFormat)}</span></label>
        </div>

        <fieldset disabled={!data?.permissions.configure || saving} className="rounded-2xl border border-slate-200 p-4">
          <legend className="px-1 text-xs font-semibold text-slate-800">工作日</legend>
          <p className="mb-3 text-[11px] leading-5 text-slate-400">至少保留一天；开启“排除周末”时，周六与周日由策略门禁锁定。</p>
          <div className="grid grid-cols-7 gap-2">{weekdays.map((day) => { const locked = excludeWeekends && day.id >= 6; const selected = !locked && workingDays.includes(day.id); return <button key={day.id} type="button" aria-pressed={selected} disabled={locked} onClick={() => toggleWorkingDay(day.id)} className={cn("h-9 rounded-lg border text-xs font-medium transition", selected ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50", locked && "cursor-not-allowed bg-slate-100 text-slate-300 hover:bg-slate-100")}>{day.label}</button>; })}</div>
        </fieldset>

        {!referenceLayout && <label className="block rounded-2xl border border-slate-100 bg-slate-50/60 p-4 text-xs font-medium text-slate-600">配置依据<textarea value={reason} onChange={(event) => setReason(event.target.value)} disabled={!data?.permissions.configure || saving} maxLength={500} placeholder="说明本次区域或日历配置的业务依据（至少 10 个字符）" className="mt-2 min-h-20 w-full resize-none rounded-xl border border-slate-200 bg-white p-3 text-sm font-normal text-slate-900 outline-none focus:border-blue-400 disabled:bg-slate-50" /></label>}

        {!referenceLayout && <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <div className="text-[11px] leading-5 text-slate-400">{data?.item ? <span className="flex items-center gap-1.5"><History className="size-3.5" />{data.item.updatedBy} · {formatDateTime(data.item.updatedAt)} · v{data.item.version}</span> : "尚无显式区域偏好记录"}</div>
          {data?.permissions.configure && <button type="button" onClick={() => void save()} disabled={saveDisabled} className="flex h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-xs font-semibold text-white shadow-sm shadow-blue-100 hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"><Save className="size-4" />{saving ? "保存中…" : "保存常规设置"}</button>}
        </div>}
        {data?.events?.length ? <div className="text-[11px] text-slate-400">最近审计：{data.events[0]?.action === "created" ? "首次明确配置" : "更新区域偏好"} · {formatDateTime(data.events[0]?.createdAt)}</div> : null}
      </>}
    </CardContent>
    </form>
  </Card>;
}
