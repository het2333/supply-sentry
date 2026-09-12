"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, Clock3, Eye, Gauge, Loader2, MoreHorizontal, Pencil, Plus, Power, PowerOff, Search, ShieldCheck, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ProcurementMaterialLeadTimesPanel } from "@/features/procurement/material-lead-times-panel";
import { procurementCalendarDate, procurementCalendarDateDaysBefore, useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS, READYWORK_PAGE_CONTAINER_CLASS, READYWORK_PAGE_TITLE_CLASS } from "@/features/procurement/visual-tokens";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";

type Contact = { id?: string; name?: string; email?: string; phone?: string; primary?: boolean };
type SupplierRoute = "local" | "import" | "unclassified";
type SupplierType = "manufacturer" | "distributor" | "service" | "other";
type Criticality = "high" | "medium" | "low" | "unclassified";
type SupplierProfile = {
  supplierId: string; countryCode: string | null; route: SupplierRoute; supplierType: SupplierType; industry: string | null;
  address: { line1: string; line2: string | null; city: string; region: string | null; postalCode: string | null; countryCode: string } | null;
  primaryMaterialCode: string | null; primaryMaterialName: string | null; defaultLeadTimeDays: number | null;
  productCriticality: Criticality; paymentTerms: string | null; contractStartsOn: string | null; contractEndsOn: string | null;
  status: "active" | "inactive"; version: number;
};
type SupplierMaster = {
  id: string; name?: string; currency?: string; status?: string; operatingStatus?: string; sourceSystem?: string; externalId?: string;
  version?: number; profile?: SupplierProfile | null; contacts?: Contact[]; email?: string; countryCode?: string; countryName?: string;
  city?: string; street?: string; street2?: string; postalCode?: string; createdAt?: string; updatedAt?: string;
};
type PurchaseOrderEvidence = { id: string; number: string; status: string; orderedAt: string; requiredInHouseAt: string | null; currency: string | null; amountTotal: number; risk: "high" | "medium" | "low" | null; riskScore: number | null; updatedAt: string };
type PerformanceSupplier = { supplierId: string; supplierName: string; status: string; currency: string | null; contacts: Contact[]; purchaseOrders: number; score: number | null; grade: string; evidenceCoverage: number; averageResponseHours: number | null; deliveryEvidence: Array<{ onTime: boolean }>; purchaseOrderItems: PurchaseOrderEvidence[] };
type PerformanceResponse = { latest: { id: string; asOf: string; ruleVersion: string; items: PerformanceSupplier[] } | null };
type LeadTimeItem = { id: string; supplier_id: string; supplier_name: string; material: string; item_code: string; material_type: string; procurement_route: "local" | "import"; standard_lead_time_days: number; status: "active" | "retired"; version: number };
type LeadTimeResponse = { items: LeadTimeItem[] };
type SupplierDirectoryResponse = { items: SupplierMaster[]; permissions: { read: boolean; configure: boolean } };
type SupplierRow = { master: SupplierMaster; profile: SupplierProfile | null; performance?: PerformanceSupplier; leadTimes: LeadTimeItem[] };
type SupplierForm = { code: string; name: string; currency: string; contactName: string; email: string; phone: string; countryCode: string; route: SupplierRoute; supplierType: SupplierType; industry: string; materialCode: string; materialName: string; leadTimeDays: string; criticality: Criticality; paymentTerms: string; reason: string };
type ActionMode = "details" | "edit" | "purchaseOrders" | "status";
type ActiveAction = { mode: ActionMode; row: SupplierRow; trigger: HTMLButtonElement | null };
type SupplierMutationKind = "create" | "edit" | "status";
type SupplierRefreshRequirement = {
  reason: "conflict" | "uncertain" | "reload";
  action: SupplierMutationKind;
  currentVersion: number | null;
};

const PAGE_SIZE = 10;
const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emptyForm: SupplierForm = { code: "", name: "", currency: "CNY", contactName: "", email: "", phone: "", countryCode: "", route: "unclassified", supplierType: "other", industry: "", materialCode: "", materialName: "", leadTimeDays: "", criticality: "unclassified", paymentTerms: "", reason: "" };
const newKey = () => typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `supplier-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const routeText: Record<string, string> = { local: "本地", import: "进口", unclassified: "未分类" };
const typeText: Record<string, string> = { manufacturer: "直接", distributor: "间接", service: "—", other: "—" };
const criticalityText: Record<string, string> = { high: "高", medium: "中", low: "低", unclassified: "未分类" };
const COUNTRY_CODES = "AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KW KG LA LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG KP MK NO OM PK PW PS PA PG PY PE PH PL PT QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA KR SS ES LK SD SR SE CH SY TW TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VA VE VN YE ZM ZW".split(" ");
const REGION_NAMES = new Intl.DisplayNames(["zh-CN"], { type: "region" });
const COUNTRY_OPTIONS = COUNTRY_CODES.map((code) => ({ code, name: REGION_NAMES.of(code) ?? code })).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
const poStatusText: Record<string, string> = { draft: "草稿", sent: "已发送", confirmed: "已确认", shipped: "已发运", received: "已收货", closed: "已关闭", cancelled: "已取消" };

function apiMessage(error: unknown) {
  if (error instanceof ReadyworkApiError) {
    if (error.status === 403) return "当前账号没有执行此供应商操作的权限。";
    if (error.status === 409) return "供应商已被其他人更新，请核对最新版本后重试。";
    if (error.status === 408) return "请求超时，请稍后重试。";
  }
  return error instanceof Error ? error.message : "供应商数据读取失败，请稍后重试。";
}
function refreshRequirementText(requirement: SupplierRefreshRequirement): string {
  if (requirement.reason === "conflict") {
    return requirement.currentVersion === null
      ? "服务端版本已变化；重试前必须重新读取。"
      : `服务端当前版本 v${requirement.currentVersion}；重试前必须重新读取。`;
  }
  return requirement.reason === "uncertain"
    ? "上次请求结果未知；重试前必须先重新读取权威状态。"
    : "写入已接受，但权威状态尚未读回；重新读取前不会再次提交。";
}
function displayKnown(value: string | undefined, labels: Record<string, string>, fallback = "未分类") { return value ? labels[value.toLowerCase()] ?? value : fallback; }
function statusText(value?: string) { return displayKnown(value, { active: "启用", inactive: "停用" }); }
function sourceText(value?: string) { return value === "odoo" ? "本地 Odoo" : value === "manual" ? "手工登记" : value || "未记录"; }
function onTimeDelivery(item?: PerformanceSupplier): number | null { return !item?.deliveryEvidence.length ? null : Math.round(item.deliveryEvidence.filter((evidence) => evidence.onTime).length / item.deliveryEvidence.length * 100); }
function directoryStatus(row: SupplierRow): "Active" | "At Risk" | "Inactive" {
  const status = row.profile?.status ?? row.master.operatingStatus ?? row.master.status;
  if (status?.toLowerCase() === "inactive") return "Inactive";
  return row.performance?.grade === "at_risk" ? "At Risk" : "Active";
}
function profileMaterial(row: SupplierRow): string {
  if (row.profile?.primaryMaterialCode || row.profile?.primaryMaterialName) return [row.profile.primaryMaterialCode, row.profile.primaryMaterialName].filter(Boolean).join(" · ");
  const fallback = row.leadTimes.find((item) => item.status === "active");
  return fallback ? [fallback.item_code, fallback.material].filter(Boolean).join(" · ") || "所有物料" : "—";
}
function profileLeadTime(row: SupplierRow): string {
  if (row.profile?.defaultLeadTimeDays !== null && row.profile?.defaultLeadTimeDays !== undefined) return `${row.profile.defaultLeadTimeDays} 天`;
  const days = [...new Set(row.leadTimes.filter((item) => item.status === "active").map((item) => item.standard_lead_time_days))].sort((a, b) => a - b);
  return !days.length ? "—" : days.length === 1 ? `${days[0]} 天` : `${days[0]}–${days.at(-1)} 天`;
}
function profilePayload(form: SupplierForm) {
  return { countryCode: form.countryCode.trim() ? form.countryCode.trim().toUpperCase() : null, route: form.route, supplierType: form.supplierType, industry: form.industry.trim() || null, address: null, primaryMaterialCode: form.materialCode.trim() || null, primaryMaterialName: form.materialName.trim() || null, defaultLeadTimeDays: form.leadTimeDays === "" ? null : Number(form.leadTimeDays), productCriticality: form.criticality, paymentTerms: form.paymentTerms.trim() || null, contractStartsOn: null, contractEndsOn: null };
}
function formFromRow(row: SupplierRow): SupplierForm {
  const primary = row.master.contacts?.find((contact) => contact.primary) ?? row.master.contacts?.[0];
  return { ...emptyForm, code: row.master.externalId ?? row.master.id, name: row.master.name ?? "", currency: row.master.currency ?? "CNY", contactName: primary?.name ?? "", email: primary?.email ?? row.master.email ?? "", phone: primary?.phone ?? "", countryCode: row.profile?.countryCode ?? row.master.countryCode ?? "", route: row.profile?.route ?? "unclassified", supplierType: row.profile?.supplierType ?? "other", industry: row.profile?.industry ?? "", materialCode: row.profile?.primaryMaterialCode ?? "", materialName: row.profile?.primaryMaterialName ?? "", leadTimeDays: row.profile?.defaultLeadTimeDays === null || row.profile?.defaultLeadTimeDays === undefined ? "" : String(row.profile.defaultLeadTimeDays), criticality: row.profile?.productCriticality ?? "unclassified", paymentTerms: row.profile?.paymentTerms ?? "", reason: "" };
}

function supplierMatchesReviewedForm(master: SupplierMaster, form: SupplierForm): boolean {
  const profile = master.profile;
  if (!profile) return false;
  const primary = master.contacts?.find((contact) => contact.primary) ?? master.contacts?.[0];
  const masterMatches = master.sourceSystem === "odoo" || (
    (master.externalId ?? master.id) === form.code.trim()
    && (master.name ?? "") === form.name.trim()
    && (master.currency ?? "CNY") === form.currency
    && (primary?.name ?? "") === form.contactName.trim()
    && (primary?.email ?? master.email ?? "") === form.email.trim()
    && (primary?.phone ?? "") === form.phone.trim()
  );
  const reviewedProfile = profilePayload(form);
  return masterMatches
    && profile.countryCode === reviewedProfile.countryCode
    && profile.route === reviewedProfile.route
    && profile.supplierType === reviewedProfile.supplierType
    && profile.industry === reviewedProfile.industry
    && profile.primaryMaterialCode === reviewedProfile.primaryMaterialCode
    && profile.primaryMaterialName === reviewedProfile.primaryMaterialName
    && profile.defaultLeadTimeDays === reviewedProfile.defaultLeadTimeDays
    && profile.productCriticality === reviewedProfile.productCriticality
    && profile.paymentTerms === reviewedProfile.paymentTerms;
}

export function ProcurementSuppliersWorkbench({ onOpenPurchaseOrder }: { onOpenPurchaseOrder?: (purchaseOrderId: string) => void }) {
  const { preferences } = useProcurementLocale();
  const initialNow = useRef(new Date());
  const [masters, setMasters] = useState<SupplierMaster[]>([]);
  const [performance, setPerformance] = useState<PerformanceResponse | null>(null);
  const [leadTimes, setLeadTimes] = useState<LeadTimeItem[]>([]);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [directoryPermissions, setDirectoryPermissions] = useState<SupplierDirectoryResponse["permissions"] | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState<SupplierRefreshRequirement | null>(null);
  const [activeAction, setActiveAction] = useState<ActiveAction | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<SupplierForm>(emptyForm);
  const [statusReason, setStatusReason] = useState("");
  const [manageSupplierId, setManageSupplierId] = useState<string | null>(null);
  const createKey = useRef(newKey());
  const mutationInFlight = useRef(false);
  const loadAbort = useRef<AbortController | null>(null);
  const createTrigger = useRef<HTMLButtonElement | null>(null);
  const createCandidate = useRef<string | null>(null);
  const from = procurementCalendarDateDaysBefore(initialNow.current, preferences.timeZone, 89);
  const to = procurementCalendarDate(initialNow.current, preferences.timeZone);

  const load = useCallback(async (): Promise<SupplierDirectoryResponse | null> => {
    loadAbort.current?.abort();
    const controller = new AbortController(); loadAbort.current = controller;
    setLoading(true); setError(null); setWarning(null); setDirectoryPermissions(null);
    try {
      const results = await Promise.allSettled([
        apiRequest<SupplierDirectoryResponse>("/api/procurement/suppliers", { signal: controller.signal }),
        apiRequest<PerformanceResponse>(`/api/procurement/supplier-performance?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, { signal: controller.signal }),
        apiRequest<LeadTimeResponse>("/api/po/lead-times", { signal: controller.signal }),
      ]);
      if (controller.signal.aborted) return null;
      if (results[0].status === "rejected") throw results[0].reason;
      setMasters(Array.isArray(results[0].value.items) ? results[0].value.items : []);
      setDirectoryPermissions({
        read: results[0].value.permissions?.read === true,
        configure: results[0].value.permissions?.configure === true,
      });
      setDirectoryLoaded(true);
      const optionalErrors: string[] = [];
      if (results[1].status === "fulfilled") setPerformance(results[1].value); else { setPerformance(null); optionalErrors.push("绩效快照"); }
      if (results[2].status === "fulfilled") setLeadTimes(results[2].value.items ?? []); else { setLeadTimes([]); optionalErrors.push("物料交期"); }
      if (optionalErrors.length) setWarning(`${optionalErrors.join("、")}暂时读取失败；供应商主数据仍按真实结果展示。`);
      return results[0].value;
    } catch (requestError) { if (!controller.signal.aborted) { setDirectoryPermissions(null); setError(apiMessage(requestError)); } }
    finally { if (loadAbort.current === controller) loadAbort.current = null; if (!controller.signal.aborted) setLoading(false); }
    return null;
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => loadAbort.current?.abort(), []);
  useEffect(() => { setPage(1); }, [query, statusFilter]);

  const performanceById = useMemo(() => new Map((performance?.latest?.items ?? []).map((item) => [item.supplierId, item] as const)), [performance]);
  const leadTimesBySupplier = useMemo(() => {
    const result = new Map<string, LeadTimeItem[]>();
    for (const item of leadTimes) result.set(item.supplier_id, [...(result.get(item.supplier_id) ?? []), item]);
    return result;
  }, [leadTimes]);
  const rows = useMemo<SupplierRow[]>(() => masters.map((master) => ({ master, profile: master.profile ?? null, performance: performanceById.get(master.id), leadTimes: leadTimesBySupplier.get(master.id) ?? [] })), [leadTimesBySupplier, masters, performanceById]);
  const filtered = useMemo(() => rows.filter((row) => {
    if (statusFilter !== "All" && directoryStatus(row) !== statusFilter) return false;
    if (!query.trim()) return true;
    const profile = row.profile;
    return [row.master.id, row.master.externalId, row.master.name, row.master.countryCode, row.master.countryName, profile?.countryCode, profile?.route, profile?.supplierType, profile?.primaryMaterialCode, profile?.primaryMaterialName].filter(Boolean).join(" ").toLowerCase().includes(query.trim().toLowerCase());
  }), [query, rows, statusFilter]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(start, start + PAGE_SIZE);

  const closeAction = () => {
    const trigger = activeAction?.trigger;
    setActiveAction(null); setStatusReason("");
    requestAnimationFrame(() => trigger?.focus());
  };
  const openAction = (mode: ActionMode, row: SupplierRow, trigger: HTMLButtonElement | null) => {
    setForm(formFromRow(row)); setStatusReason(""); setError(null); setNotice(null); setRefreshRequired(null); setActiveAction({ mode, row, trigger });
  };
  const mutationCurrentVersion = (requestError: ReadyworkApiError): number | null => {
    if (!requestError.payload || typeof requestError.payload !== "object") return null;
    const payload = requestError.payload as Record<string, unknown>;
    const version = payload["currentVersion"] ?? payload["current_version"];
    return typeof version === "number" && Number.isSafeInteger(version) ? version : null;
  };
  const recordMutationFailure = (requestError: unknown, action: SupplierMutationKind) => {
    setError(apiMessage(requestError));
    if (!(requestError instanceof ReadyworkApiError)) return;
    if (requestError.status === 403) {
      setDirectoryPermissions((current) => current ? { ...current, configure: false } : { read: false, configure: false });
      return;
    }
    if (requestError.status === 409 || requestError.status === 404) {
      setRefreshRequired({ reason: "conflict", action, currentVersion: mutationCurrentVersion(requestError) });
    } else if (requestError.status === 0 || requestError.status === 408) {
      setRefreshRequired({ reason: "uncertain", action, currentVersion: null });
    }
  };
  const reloadAfterMutation = async (action: SupplierMutationKind, currentVersion: number | null): Promise<boolean> => {
    if (await load()) return true;
    setError("写入已由服务端接受，但最新权威供应商状态尚未读回；重新读取前不会再次提交。");
    setRefreshRequired({ reason: "reload", action, currentVersion });
    return false;
  };
  const rereadMutationAuthority = async () => {
    if (!refreshRequired || loading) return;
    const requirement = refreshRequired;
    const result = await load();
    if (!result) return;
    const reviewedAction = activeAction;
    const refreshedMaster = reviewedAction
      ? result.items.find((item) => item.id === reviewedAction.row.master.id)
      : null;
    const refreshedRow = refreshedMaster && reviewedAction
      ? { ...reviewedAction.row, master: refreshedMaster, profile: refreshedMaster.profile ?? null }
      : null;
    if (refreshedMaster) {
      setActiveAction((current) => current ? {
        ...current,
        row: { ...current.row, master: refreshedMaster, profile: refreshedMaster.profile ?? null },
      } : current);
    }
    setRefreshRequired(null);
    setError(null);
    if (requirement.reason === "uncertain") {
      const acceptedCreate = requirement.action === "create"
        && result.items.some((item) => supplierMatchesReviewedForm(item, form));
      const acceptedEdit = requirement.action === "edit"
        && reviewedAction?.mode === "edit"
        && refreshedMaster
        ? supplierMatchesReviewedForm(refreshedMaster, form)
          && ((refreshedMaster.version ?? 0) > (reviewedAction.row.master.version ?? 0)
            || (refreshedMaster.profile?.version ?? 0) > (reviewedAction.row.profile?.version ?? 0))
        : false;
      const intendedStatus = reviewedAction?.row.profile?.status === "active" ? "inactive" : "active";
      const acceptedStatus = requirement.action === "status"
        && reviewedAction?.mode === "status"
        && refreshedRow?.profile?.status === intendedStatus
        && refreshedRow.profile.version > (reviewedAction.row.profile?.version ?? 0);
      if (acceptedCreate || acceptedEdit || acceptedStatus) {
        if (acceptedCreate) {
          createKey.current = newKey(); createCandidate.current = null; setForm(emptyForm); setShowCreate(false);
          requestAnimationFrame(() => requestAnimationFrame(() => createTrigger.current?.focus()));
          setNotice("供应商主数据与运营档案已从服务端确认保存。");
        } else {
          closeAction();
          setNotice(acceptedStatus ? "供应商状态已从服务端确认更新。" : "供应商档案已从服务端确认更新。");
        }
        return;
      }
      setNotice(result.permissions.configure
        ? "已重新读取服务端状态；原请求未落库，已审核输入仍保留，现在可以安全重试。"
        : "已重新读取服务端状态；当前账号没有配置权限，已审核输入仍保留。");
      return;
    }
    if (requirement.reason !== "reload") {
      setNotice("已重新读取服务端版本；已审核输入仍保留，现在可以重新提交。");
      return;
    }
    if (requirement.action === "create") {
      createKey.current = newKey(); createCandidate.current = null; setForm(emptyForm); setShowCreate(false);
      requestAnimationFrame(() => requestAnimationFrame(() => createTrigger.current?.focus()));
      setNotice("供应商主数据与运营档案已从服务端确认保存。");
    } else {
      closeAction();
      setNotice(requirement.action === "status" ? "供应商状态已从服务端确认更新。" : "供应商档案已从服务端确认更新。");
    }
  };
  const register = async () => {
    if (refreshRequired || mutationInFlight.current || saving || directoryPermissions?.configure !== true || !form.code.trim() || !form.name.trim() || !form.countryCode || form.route === "unclassified" || !["manufacturer", "distributor"].includes(form.supplierType) || !form.contactName.trim() || !emailValid.test(form.email.trim()) || !form.phone.trim()) return;
    mutationInFlight.current = true;
    setSaving(true); setError(null); setNotice(null);
    try {
      const candidatePayload = { externalId: form.code.trim(), name: form.name.trim(), currency: form.currency, primaryContact: { name: form.contactName.trim(), email: form.email.trim(), phone: form.phone.trim() }, operatingProfile: profilePayload(form) };
      const candidate = JSON.stringify(candidatePayload);
      if (createCandidate.current !== null && createCandidate.current !== candidate) createKey.current = newKey();
      createCandidate.current = candidate;
      const response = await apiRequest<{ version?: number }>("/api/procurement/suppliers", { method: "POST", body: { idempotencyKey: createKey.current, ...candidatePayload } });
      if (!(await reloadAfterMutation("create", response.version ?? null))) return;
      createKey.current = newKey(); createCandidate.current = null; setForm(emptyForm); setShowCreate(false); setNotice("供应商主数据与运营档案已在同一事务中保存。");
      requestAnimationFrame(() => requestAnimationFrame(() => createTrigger.current?.focus()));
    } catch (requestError) { recordMutationFailure(requestError, "create"); } finally { mutationInFlight.current = false; setSaving(false); }
  };
  const saveEdit = async () => {
    if (refreshRequired || !activeAction || activeAction.mode !== "edit" || mutationInFlight.current || saving || directoryPermissions?.configure !== true) return;
    mutationInFlight.current = true;
    const row = activeAction.row; setSaving(true); setError(null); setNotice(null);
    try {
      const response = await apiRequest<{ version?: number }>(`/api/procurement/suppliers/${encodeURIComponent(row.master.id)}`, { method: "PATCH", body: { expectedVersion: row.master.version ?? 1, expectedProfileVersion: row.profile?.version ?? 0, reason: "通过供应商编辑器更新。", ...(row.master.sourceSystem === "odoo" ? {} : { name: form.name.trim(), currency: form.currency, primaryContact: { name: form.contactName.trim(), email: form.email.trim(), phone: form.phone.trim() } }), operatingProfile: profilePayload(form) } });
      if (!(await reloadAfterMutation("edit", response.version ?? null))) return;
      closeAction(); setNotice("供应商档案已更新；刷新后仍使用服务端持久化版本。");
    } catch (requestError) { recordMutationFailure(requestError, "edit"); }
    finally { mutationInFlight.current = false; setSaving(false); }
  };
  const changeStatus = async () => {
    if (refreshRequired || !activeAction || activeAction.mode !== "status" || mutationInFlight.current || saving || directoryPermissions?.configure !== true || statusReason.trim().length < 10 || !activeAction.row.profile) return;
    mutationInFlight.current = true;
    const row = activeAction.row; const profile = row.profile;
    if (!profile) return;
    const deactivate = profile.status === "active";
    setSaving(true); setError(null); setNotice(null);
    try {
      const response = await apiRequest<{ version?: number }>(`/api/procurement/suppliers/${encodeURIComponent(row.master.id)}/${deactivate ? "deactivate" : "reactivate"}`, { method: "POST", body: { expectedVersion: profile.version, reason: statusReason.trim() } });
      if (!(await reloadAfterMutation("status", response.version ?? null))) return;
      closeAction(); setNotice(deactivate ? "供应商已停用；历史采购订单与事件保持不变。" : "供应商已重新启用，并保留完整状态事件。");
    } catch (requestError) { recordMutationFailure(requestError, "status"); }
    finally { mutationInFlight.current = false; setSaving(false); }
  };

  return <div className={`${READYWORK_PAGE_CONTAINER_CLASS} -mt-[14.5px] pb-12`}>
    <div className="space-y-5">
      <div className={`flex min-h-[134.5px] items-start justify-between gap-4 ${READYWORK_INTEGRATED_HEADER_ACTION_GUTTER_CLASS}`}>
        <div className="min-w-0"><div className="mb-2 text-[11px] font-medium text-[#8a94a6]">设置 <span className="px-1 text-[#c1c7d0]">/</span> <span className="text-[#4b5565]">供应商</span></div><h1 className={READYWORK_PAGE_TITLE_CLASS}>供应商</h1><p className="mt-1 text-sm text-slate-500">管理和维护采购流程中使用的所有供应商主数据。</p></div>
        {directoryPermissions?.configure === true && <button ref={createTrigger} type="button" onClick={() => { setForm(emptyForm); setShowCreate(true); }} className="mt-[11.5px] inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-xl bg-[#2563eb] px-3 text-xs font-medium text-white shadow-sm transition hover:bg-[#1d4ed8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"><Plus className="size-3.5" />添加供应商</button>}
      </div>
      {error && <div role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div>}
      {refreshRequired && <SupplierRefreshAlert requirement={refreshRequired} loading={loading} onReread={() => void rereadMutationAuthority()} />}
      {warning && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-800">{warning}</div>}
      {notice && <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</div>}
      <section className="min-w-0 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/30">
        <div className="flex items-center gap-2.5 p-4">
          <label className="relative min-w-[260px] flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按供应商名称、编码或国家/地区搜索…" className="h-9 w-full rounded-xl border border-slate-200 pl-9 pr-3 text-[13px] outline-none focus:border-blue-300 focus:ring-4 focus:ring-blue-50" /></label>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="供应商状态" className="h-9 rounded-xl border border-slate-200 bg-white px-3 text-[13px] font-medium text-slate-600"><option value="All">状态</option><option value="Active">启用</option><option value="At Risk">存在风险</option><option value="Inactive">停用</option></select>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[940px] border-collapse text-left">
            <thead><tr className="border-y border-slate-200 bg-slate-50/80">{["供应商编码", "供应商名称", "国家/地区", "采购路线", "类型", "准时交付率", "状态"].map((label) => <th key={label} className="whitespace-nowrap px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</th>)}<th className="w-20 px-3 py-3" /></tr></thead>
            <tbody>{loading && !directoryLoaded ? <tr><td colSpan={8} className="px-4 py-14 text-center text-sm text-slate-400"><span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />正在加载供应商…</span></td></tr> : !directoryLoaded ? <tr><td colSpan={8} className="px-4 py-14 text-center text-sm text-slate-400">供应商主数据尚未成功读取，请通过上方提示重试。</td></tr> : pageRows.length ? pageRows.map((row, index) => <SupplierTableRow key={row.master.id} row={row} alternate={index % 2 === 1} configure={directoryPermissions?.configure === true} onAction={openAction} onManageLeadTimes={(supplierId) => setManageSupplierId(supplierId)} />) : <tr><td colSpan={8} className="px-4 py-14 text-center text-sm text-slate-400">没有符合搜索条件的供应商。</td></tr>}</tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-4 text-[13px] text-slate-500">{directoryLoaded ? <><p>显示第 <span className="font-medium text-slate-800">{filtered.length ? start + 1 : 0}</span> 至 <span className="font-medium text-slate-800">{Math.min(start + PAGE_SIZE, filtered.length)}</span> 条，共 <span className="font-medium text-slate-800">{filtered.length}</span> 条</p><div className="flex items-center gap-1"><button type="button" aria-label="上一页" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage === 1} className="flex size-8 items-center justify-center rounded-lg border border-slate-200 disabled:opacity-40"><ChevronLeft className="size-4" /></button>{Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNumber) => <button key={pageNumber} type="button" aria-label={`第 ${pageNumber} 页`} aria-current={pageNumber === currentPage ? "page" : undefined} onClick={() => setPage(pageNumber)} className={`flex size-8 items-center justify-center rounded-lg text-xs font-medium ${pageNumber === currentPage ? "bg-blue-600 text-white" : "border border-slate-200 bg-white text-slate-600"}`}>{pageNumber}</button>)}<button type="button" aria-label="下一页" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={currentPage === totalPages} className="flex size-8 items-center justify-center rounded-lg border border-slate-200 disabled:opacity-40"><ChevronRight className="size-4" /></button></div></> : <p>等待权威供应商数据。</p>}</div>
      </section>
      <ProcurementMaterialLeadTimesPanel manageSupplierId={directoryPermissions?.configure === true ? manageSupplierId : null} onManageHandled={() => setManageSupplierId(null)} />
    </div>
    {showCreate && <SupplierEditorModal title="添加新供应商" subtitle="创建新的供应商主数据记录。" form={form} setForm={setForm} saving={saving} writable={directoryPermissions?.configure === true} blocked={Boolean(refreshRequired)} mutationError={error} refreshRequired={refreshRequired} rereading={loading} onReread={() => void rereadMutationAuthority()} returnFocusElement={createTrigger.current} sourceSystem="manual" onClose={() => { if (!saving) setShowCreate(false); }} onSave={() => void register()} saveLabel="保存供应商" />}
    {activeAction?.mode === "details" && <SupplierDetailModal row={activeAction.row} onClose={closeAction} onOpenPurchaseOrder={onOpenPurchaseOrder} />}
    {activeAction?.mode === "purchaseOrders" && <SupplierPurchaseOrdersModal row={activeAction.row} onClose={closeAction} onOpenPurchaseOrder={onOpenPurchaseOrder} />}
    {activeAction?.mode === "edit" && <SupplierEditorModal title="编辑供应商" subtitle="更新该供应商的主数据记录。" form={form} setForm={setForm} saving={saving} writable={directoryPermissions?.configure === true} blocked={Boolean(refreshRequired)} mutationError={error} refreshRequired={refreshRequired} rereading={loading} onReread={() => void rereadMutationAuthority()} returnFocusElement={activeAction.trigger} sourceSystem={activeAction.row.master.sourceSystem ?? "manual"} onClose={closeAction} onSave={() => void saveEdit()} saveLabel="保存更改" />}
    {activeAction?.mode === "status" && <SupplierStatusModal row={activeAction.row} reason={statusReason} setReason={setStatusReason} saving={saving} writable={directoryPermissions?.configure === true} blocked={Boolean(refreshRequired)} mutationError={error} refreshRequired={refreshRequired} rereading={loading} onReread={() => void rereadMutationAuthority()} returnFocusElement={activeAction.trigger} onClose={closeAction} onConfirm={() => void changeStatus()} />}
  </div>;
}

function SupplierTableRow({ row, alternate, configure, onAction, onManageLeadTimes }: { row: SupplierRow; alternate: boolean; configure: boolean; onAction: (mode: ActionMode, row: SupplierRow, trigger: HTMLButtonElement | null) => void; onManageLeadTimes: (supplierId: string) => void }) {
  const profile = row.profile; const delivery = onTimeDelivery(row.performance); const status = directoryStatus(row);
  return <tr className={`border-b border-slate-100 transition hover:bg-blue-50/40 ${alternate ? "bg-slate-50/40" : ""}`}>
    <td data-preserve-language className="max-w-[160px] truncate px-4 py-3.5 font-mono text-[12px] font-semibold text-blue-600" title={row.master.externalId || row.master.id}>{row.master.externalId || row.master.id}</td>
    <td data-preserve-language className="whitespace-nowrap px-4 py-3.5 text-[13px] font-medium text-slate-900">{row.master.name || "未命名供应商"}</td>
    <td data-preserve-language className="whitespace-nowrap px-4 py-3.5 text-[13px] text-slate-600">{row.master.countryName || profile?.countryCode || row.master.countryCode || "—"}</td>
    <td className="px-4 py-3.5">{profile && profile.route !== "unclassified" ? <Badge tone={profile.route === "import" ? "violet" : "blue"}><span data-preserve-language={routeText[profile.route] ? undefined : true}>{displayKnown(profile.route, routeText)}</span></Badge> : <span className="text-[13px] text-slate-400">—</span>}</td>
    <td className="whitespace-nowrap px-4 py-3.5 text-[13px] text-slate-600">{profile ? <span data-preserve-language={typeText[profile.supplierType] ? undefined : true}>{displayKnown(profile.supplierType, typeText)}</span> : "—"}</td>
    <td className="px-4 py-3.5">{delivery === null ? <span className="text-[13px] text-slate-400">—</span> : <div className="flex items-center gap-2.5"><span className="w-9 text-[13px] font-semibold text-slate-900">{delivery}%</span><span role="progressbar" aria-label={`${row.master.name || "供应商"}准时交付率`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={delivery} className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-100"><span className="block h-full rounded-full" style={{ width: `${delivery}%`, backgroundColor: delivery >= 90 ? "#16a34a" : delivery >= 75 ? "#f59e0b" : "#ef4444" }} /></span></div>}</td>
    <td className="px-4 py-3.5"><Badge tone={status === "Active" ? "green" : status === "At Risk" ? "amber" : "neutral"}>{status === "Active" ? "启用" : status === "At Risk" ? "存在风险" : "停用"}</Badge></td>
    <td className="px-3 py-3.5"><div className="flex items-center gap-1">{configure && <button type="button" aria-label={`编辑供应商 ${row.master.name || "供应商"}`} onClick={(event) => onAction("edit", row, event.currentTarget)} className="flex size-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"><Pencil className="size-3.5" /></button>}<SupplierActionsMenu row={row} configure={configure} onAction={onAction} onManageLeadTimes={onManageLeadTimes} /></div></td>
  </tr>;
}

function SupplierActionsMenu({ row, configure, onAction, onManageLeadTimes }: { row: SupplierRow; configure: boolean; onAction: (mode: ActionMode, row: SupplierRow, trigger: HTMLButtonElement | null) => void; onManageLeadTimes: (supplierId: string) => void }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const supplierName = row.master.name || "供应商";
  const menuId = `supplier-actions-${row.master.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const choose = (mode: ActionMode) => onAction(mode, row, trigger.current);
  const itemClassName = "gap-2 px-2 text-xs font-medium text-slate-700 data-[highlighted]:bg-slate-50";
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button ref={trigger} type="button" aria-label={`更多供应商操作：${supplierName}`} className="flex size-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-700"><MoreHorizontal className="size-4" /></button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      id={menuId}
      aria-label={`供应商操作：${supplierName}`}
      aria-labelledby={undefined}
      align="end"
      className="w-52"
      onKeyDownCapture={(event) => {
        if (event.key !== "Home" && event.key !== "End") return;
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])')];
        const target = event.key === "Home" ? items[0] : items.at(-1);
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        target.focus();
      }}
    >
      <DropdownMenuItem onSelect={() => choose("details")} className={itemClassName}><Eye className="size-3.5" />查看详情</DropdownMenuItem>
      {configure && <DropdownMenuItem onSelect={() => choose("edit")} className={itemClassName}><Pencil className="size-3.5" />编辑供应商</DropdownMenuItem>}
      {configure && <DropdownMenuItem onSelect={() => onManageLeadTimes(row.master.id)} className={itemClassName}><Clock3 className="size-3.5" />管理交期</DropdownMenuItem>}
      <DropdownMenuItem onSelect={() => choose("purchaseOrders")} className={itemClassName}><ArrowUpRight className="size-3.5" />查看采购订单</DropdownMenuItem>
      {configure && <DropdownMenuItem onSelect={() => choose("status")} disabled={!row.profile} className={`${itemClassName} ${row.profile?.status !== "inactive" ? "text-red-600 data-[highlighted]:bg-red-50 data-[highlighted]:text-red-600" : ""}`}>{row.profile?.status === "inactive" ? <Power className="size-3.5" /> : <PowerOff className="size-3.5" />}{row.profile?.status === "inactive" ? "重新启用" : "停用"}</DropdownMenuItem>}
    </DropdownMenuContent>
  </DropdownMenu>;
}

function SupplierEditorModal({ title, subtitle, form, setForm, saving, writable, blocked, mutationError, refreshRequired, rereading, onReread, returnFocusElement, sourceSystem, onClose, onSave, saveLabel }: { title: string; subtitle: string; form: SupplierForm; setForm: Dispatch<SetStateAction<SupplierForm>>; saving: boolean; writable: boolean; blocked: boolean; mutationError: string | null; refreshRequired: SupplierRefreshRequirement | null; rereading: boolean; onReread: () => void; returnFocusElement: HTMLElement | null; sourceSystem: string; onClose: () => void; onSave: () => void; saveLabel: string }) {
  const masterEditable = sourceSystem !== "odoo";
  const valid = Boolean(form.code.trim() && form.name.trim() && form.countryCode && form.route !== "unclassified" && (form.supplierType === "manufacturer" || form.supplierType === "distributor") && form.contactName.trim() && emailValid.test(form.email.trim()) && form.phone.trim());
  return <Modal title={title} subtitle={subtitle} returnFocusElement={returnFocusElement} onClose={() => !saving && onClose()} compact>
    {mutationError && <div role="alert" className="rounded-xl bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700">{mutationError}</div>}
    {refreshRequired && <SupplierRefreshAlert requirement={refreshRequired} loading={rereading} onReread={onReread} />}
    <DetailSection number="1" title="供应商信息"><div className="grid grid-cols-2 gap-x-4 gap-y-4">
      <Field label="供应商编码 *"><input aria-label="供应商编码 *" placeholder="输入供应商编码" value={form.code} disabled={!writable || !masterEditable} onChange={(event) => setForm({ ...form, code: event.target.value })} /></Field>
      <Field label="供应商名称 *"><input aria-label="供应商名称 *" placeholder="输入供应商名称" value={form.name} disabled={!writable || !masterEditable} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
      <Field label="国家/地区 *"><CountryPicker value={form.countryCode} disabled={!writable} onChange={(countryCode) => setForm({ ...form, countryCode })} /></Field>
      <Field label="采购路线 *"><select aria-label="采购路线 *" value={form.route} disabled={!writable} onChange={(event) => setForm({ ...form, route: event.target.value as SupplierRoute })}><option value="unclassified" disabled>选择采购路线</option><option value="local">本地</option><option value="import">进口</option></select></Field>
      <Field label="类型 *"><select aria-label="类型 *" value={form.supplierType} disabled={!writable} onChange={(event) => setForm({ ...form, supplierType: event.target.value as SupplierType })}><option value="other" disabled>选择类型</option><option value="manufacturer">直接</option><option value="distributor">间接</option></select></Field>
    </div></DetailSection>
    <DetailSection number="2" title="联系人信息"><div className="grid grid-cols-2 gap-x-4 gap-y-4">
      <Field label="联系人 *"><input aria-label="联系人 *" placeholder="输入联系人" value={form.contactName} disabled={!writable || !masterEditable} onChange={(event) => setForm({ ...form, contactName: event.target.value })} /></Field>
      <Field label="邮箱 *"><input aria-label="邮箱 *" placeholder="输入邮箱" type="email" value={form.email} disabled={!writable || !masterEditable} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
      <Field label="电话 *" wide><input aria-label="电话 *" placeholder="输入电话号码" value={form.phone} disabled={!writable || !masterEditable} onChange={(event) => setForm({ ...form, phone: event.target.value })} /><span className="mt-1.5 block text-[11px] font-normal text-slate-500">如果您通过 WhatsApp 联系该供应商，请填写 WhatsApp 号码。</span></Field>
    </div></DetailSection>
    <div className="-mx-6 -mb-6 flex justify-end gap-3 border-t border-slate-100 px-6 py-4"><Button variant="outline" onClick={onClose} disabled={saving}>取消</Button><Button onClick={onSave} aria-busy={saving} disabled={!writable || !valid || saving || blocked}>{saving && <Loader2 className="size-4 animate-spin" />}{saving ? "正在保存…" : saveLabel}</Button></div>
  </Modal>;
}

function CountryPicker({ value, disabled = false, onChange }: { value: string; disabled?: boolean; onChange: (countryCode: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const selected = COUNTRY_OPTIONS.find((country) => country.code === value);
  const matches = COUNTRY_OPTIONS.filter((country) => country.name.toLowerCase().includes(query.trim().toLowerCase()));
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  }, []);
  useEffect(() => {
    if (disabled && open) close(false);
  }, [close, disabled, open]);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => search.current?.focus());
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || panel.current?.contains(event.target) || trigger.current?.contains(event.target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [close, open]);
  const picker = open ? (
    <div
      ref={panel}
      role="dialog"
      aria-label="选择国家/地区"
      className="absolute left-0 top-[calc(100%+4px)] z-[100] w-[300px] max-w-[calc(100vw-48px)] rounded-xl border border-slate-200 bg-white p-2 shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); close(true); return; }
        const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-country-option]')];
        if (document.activeElement === search.current && event.key === "ArrowDown") {
          event.preventDefault(); options[0]?.focus(); return;
        }
        const current = options.indexOf(document.activeElement as HTMLButtonElement);
        if (current < 0 || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : event.key === "ArrowDown" ? (current + 1) % options.length : (current - 1 + options.length) % options.length;
        options[next]?.focus();
      }}
    >
      <div className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" /><input ref={search} aria-label="搜索国家/地区…" placeholder="搜索国家/地区…" value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 w-full rounded-lg border border-slate-200 pl-9 pr-3 text-sm outline-none focus:border-blue-400" /></div>
      <div className="mt-2 max-h-64 overflow-y-auto">{matches.map((country) => <button data-country-option key={country.code} type="button" onClick={() => { onChange(country.code); close(true); }} className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"><span>{country.name}</span>{country.code === value && <Check className="size-4 text-blue-600" />}</button>)}</div>
    </div>
  ) : null;
  return <div className="relative">
    <button ref={trigger} type="button" aria-label="国家/地区 *" aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen((current) => !current)} className="flex h-10 w-full items-center justify-between rounded-xl border border-slate-200 bg-white px-3 text-left text-sm outline-none focus:border-blue-400 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"><span className={selected ? "text-slate-800" : "text-slate-400"}>{selected?.name ?? "选择国家/地区"}</span><ChevronDown className="size-4 text-slate-400" /></button>
    {picker}
  </div>;
}

function SupplierStatusModal({ row, reason, setReason, saving, writable, blocked, mutationError, refreshRequired, rereading, onReread, returnFocusElement, onClose, onConfirm }: { row: SupplierRow; reason: string; setReason: (value: string) => void; saving: boolean; writable: boolean; blocked: boolean; mutationError: string | null; refreshRequired: SupplierRefreshRequirement | null; rereading: boolean; onReread: () => void; returnFocusElement: HTMLElement | null; onClose: () => void; onConfirm: () => void }) {
  const deactivate = row.profile?.status !== "inactive";
  return <Modal title={deactivate ? "停用供应商" : "重新启用供应商"} subtitle={`${row.master.name} · 档案版本 v${row.profile?.version ?? 0}`} returnFocusElement={returnFocusElement} onClose={() => !saving && onClose()}>{mutationError && <div role="alert" className="rounded-xl bg-red-50 px-3 py-2.5 text-xs leading-5 text-red-700">{mutationError}</div>}{refreshRequired && <SupplierRefreshAlert requirement={refreshRequired} loading={rereading} onReread={onReread} />}<div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">此操作不会删除供应商、采购订单或历史事件；状态变化会追加新版本。</div><Field label="原因 *"><textarea aria-label="供应商状态变更原因" value={reason} disabled={!writable} onChange={(event) => setReason(event.target.value)} placeholder="至少 10 个字符" /></Field><div className="flex justify-end gap-3"><Button variant="outline" onClick={onClose} disabled={saving}>取消</Button><Button variant={deactivate ? "danger" : "default"} onClick={onConfirm} aria-busy={saving} disabled={!writable || saving || blocked || reason.trim().length < 10}>{saving ? <Loader2 className="size-4 animate-spin" /> : deactivate ? <PowerOff className="size-4" /> : <Power className="size-4" />}{saving ? "正在保存…" : deactivate ? "确认停用" : "确认重新启用"}</Button></div></Modal>;
}

function SupplierRefreshAlert({ requirement, loading, onReread }: { requirement: SupplierRefreshRequirement; loading: boolean; onReread: () => void }) {
  return <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800"><span>{refreshRequirementText(requirement)}</span><button type="button" onClick={onReread} disabled={loading} className="shrink-0 font-semibold text-amber-900 hover:underline disabled:opacity-50">重新读取</button></div>;
}

function SupplierDetailModal({ row, onClose, onOpenPurchaseOrder }: { row: SupplierRow; onClose: () => void; onOpenPurchaseOrder?: (purchaseOrderId: string) => void }) {
  const { formatShortDateTime } = useProcurementLocale(); const primary = row.master.contacts?.find((contact) => contact.primary) ?? row.master.contacts?.[0]; const delivery = onTimeDelivery(row.performance);
  return <Modal title={row.master.name || "供应商详情"} subtitle={row.master.externalId || row.master.id} onClose={onClose}><DetailSection title="运营档案"><div className="grid grid-cols-2 gap-4"><Fact label="国家/地区" value={row.profile?.countryCode || row.master.countryName || row.master.countryCode || "—"} /><Fact label="采购路线" value={row.profile ? displayKnown(row.profile.route, routeText) : "未分类"} /><Fact label="类型" value={row.profile ? displayKnown(row.profile.supplierType, typeText) : "未分类"} /><Fact label="行业" value={row.profile?.industry || "—"} /><Fact label="关键程度" value={row.profile ? displayKnown(row.profile.productCriticality, criticalityText) : "未分类"} /><Fact label="物料" value={profileMaterial(row)} /><Fact label="交期" value={profileLeadTime(row)} /><Fact label="状态" value={statusText(row.profile?.status ?? row.master.status)} /><Fact label="档案版本" value={row.profile ? `v${row.profile.version}` : "尚未创建"} /></div></DetailSection><DetailSection title="主数据与联系人"><div className="grid grid-cols-2 gap-4"><Fact label="来源" value={sourceText(row.master.sourceSystem)} /><Fact label="币种" value={row.master.currency || "—"} /><Fact label="联系人" value={primary?.name || "—"} /><Fact label="邮箱" value={primary?.email || row.master.email || "—"} /><Fact label="更新时间" value={formatShortDateTime(row.master.updatedAt)} wide /></div></DetailSection><DetailSection title="绩效"><div className="grid grid-cols-3 gap-3"><Metric icon={Gauge} label="评分" value={row.performance?.score === null || row.performance?.score === undefined ? "—" : String(row.performance.score)} /><Metric icon={ShieldCheck} label="证据覆盖率" value={`${row.performance?.evidenceCoverage ?? 0}%`} /><Metric icon={Truck} label="准时交付率" value={delivery === null ? "—" : `${delivery}%`} /></div></DetailSection>{row.performance?.purchaseOrderItems[0] && onOpenPurchaseOrder && <Button variant="outline" onClick={() => onOpenPurchaseOrder(row.performance!.purchaseOrderItems[0]!.id)}>打开最新采购订单 <ArrowUpRight className="size-4" /></Button>}</Modal>;
}
function SupplierPurchaseOrdersModal({ row, onClose, onOpenPurchaseOrder }: { row: SupplierRow; onClose: () => void; onOpenPurchaseOrder?: (purchaseOrderId: string) => void }) {
  const { formatDate } = useProcurementLocale(); const items = row.performance?.purchaseOrderItems ?? [];
  return <Modal title="采购订单" subtitle={`${row.master.name} · ${row.master.id}`} onClose={onClose}><div className="overflow-hidden rounded-xl border border-slate-200">{items.length ? items.map((po) => <button key={po.id} type="button" onClick={() => onOpenPurchaseOrder?.(po.id)} disabled={!onOpenPurchaseOrder} className="grid w-full grid-cols-[minmax(120px,1fr)_100px_120px] gap-3 border-b border-slate-100 px-3 py-3 text-left text-xs last:border-b-0 hover:bg-blue-50 disabled:hover:bg-white"><span data-preserve-language className="font-semibold text-blue-600">{po.number}</span><span data-preserve-language={poStatusText[po.status] ? undefined : true}>{poStatusText[po.status] ?? po.status}</span><span>需入库 {formatDate(po.requiredInHouseAt)}</span></button>) : <div className="px-4 py-10 text-center text-xs text-slate-400">该供应商暂无采购订单。</div>}</div></Modal>;
}
function Modal({ title, subtitle, returnFocusElement = null, onClose, children, compact = false }: { title: string; subtitle?: string; returnFocusElement?: HTMLElement | null; onClose: () => void; children: ReactNode; compact?: boolean }) {
  const returnFocusRef = useRef<HTMLElement | null>(returnFocusElement);
  if (!returnFocusRef.current && returnFocusElement) returnFocusRef.current = returnFocusElement;
  useEffect(() => {
    const element = returnFocusRef.current;
    return () => { if (element) requestAnimationFrame(() => requestAnimationFrame(() => element.focus())); };
  }, []);
  return <Dialog open onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
    <DialogContent closeLabel="关闭" className={`${compact ? "max-w-[560px]" : "max-w-[680px]"} overflow-hidden rounded-3xl p-0`} aria-label={title} onCloseAutoFocus={(event) => { if (!returnFocusElement) return; event.preventDefault(); returnFocusElement.focus(); }}>
      <div className="border-b border-slate-100 px-6 py-5 pr-14"><DialogTitle data-preserve-language className="text-lg font-bold tracking-tight text-slate-950">{title}</DialogTitle>{subtitle && <DialogDescription data-preserve-language className="mt-1 text-xs text-slate-500">{subtitle}</DialogDescription>}</div>
      <div className="max-h-[calc(100dvh-190px)] space-y-7 overflow-y-auto px-6 py-6">{children}</div>
    </DialogContent>
  </Dialog>;
}
function DetailSection({ number, title, children }: { number?: string; title: string; children: ReactNode }) { return <section><div className="mb-3.5 flex items-center gap-2">{number && <span className="flex size-6 items-center justify-center rounded-full bg-blue-50 text-xs font-semibold text-blue-600">{number}</span>}<h3 className="text-sm font-semibold text-slate-900">{title}</h3></div>{children}</section>; }
function Fact({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) { return <div className={wide ? "col-span-2" : ""}><div className="text-xs font-medium text-slate-400">{label}</div><div data-preserve-language className="mt-1 text-[13px] font-medium text-slate-800">{value}</div></div>; }
function Metric({ icon: Icon, label, value }: { icon: typeof Gauge; label: string; value: string }) { return <div className="rounded-xl border border-slate-200 p-3"><Icon className="size-4 text-slate-400" /><div className="mt-2 text-lg font-semibold text-slate-900">{value}</div><div className="mt-1 text-[10px] text-slate-400">{label}</div></div>; }
function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) { return <label className={`block text-xs font-medium text-slate-600 ${wide ? "col-span-2" : ""}`}><span>{label}</span><span className="mt-1.5 block [&_input]:h-10 [&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:border-slate-200 [&_input]:px-3 [&_input]:text-sm [&_input]:outline-none [&_input]:focus:border-blue-400 [&_select]:h-10 [&_select]:w-full [&_select]:rounded-xl [&_select]:border [&_select]:border-slate-200 [&_select]:bg-white [&_select]:px-3 [&_select]:text-sm [&_textarea]:min-h-24 [&_textarea]:w-full [&_textarea]:rounded-xl [&_textarea]:border [&_textarea]:border-slate-200 [&_textarea]:p-3">{children}</span></label>; }
