"use client";

import { uiPrompt } from "@/features/localization/ui-dialogs";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle, AlertTriangle, ArrowRight, CalendarDays, CheckCircle2, ChevronLeft, Filter,
  ChevronRight, Download, ExternalLink, FileCheck2, FileUp, Globe2, Link2,
  Loader2, Mail, PanelLeftOpen, RefreshCw, Save, Search, ShieldAlert,
  ShoppingCart, Sparkles, Trash2, X,
} from "lucide-react";
import { apiRequest, ReadyworkApiError } from "@/features/shared/api-client";
import { cn } from "@/lib/utils";
import type { RouteRiskSummary } from "@/features/procurement/route-risk-overview";
import {
  routeEvidenceCoverage,
  supplierRouteEvidenceSyncMessage,
  type SupplierMasterSyncResult,
} from "@/features/procurement/route-evidence-sync";
import { useProcurementLocale } from "@/features/procurement/tenant-preferences-context";
import { READYWORK_PAGE_CONTAINER_CLASS, READYWORK_PAGE_TITLE_CLASS } from "@/features/procurement/visual-tokens";
import { RouteChat } from "@/features/procurement/route-chat";
import { RouteDateRangeFilter, RouteFilterMenu, RouteOrderActionsMenu } from "@/features/procurement/route-workbench-controls";
import { routeMaterialTypeLabel, routeRiskReason, routeStageLabel, type PortfolioRiskFactor } from "@/features/procurement/route-workbench-view-model";
import { useProcurementRealtimeRefresh } from "@/features/procurement/realtime-events";

type Route = "local" | "import" | "unclassified";
type RouteEvidenceType = "contract" | "incoterm" | "erp_field" | "manual_review";
type Risk = "high" | "medium" | "low";
type RouteRiskBucket = "high_risk" | "awaiting_supplier" | "delivery_risk" | "on_track";
type FollowupReadiness = {
  ready: boolean;
  code: "ready" | "communication_identity_missing" | "supplier_email_missing" | "invalid_state";
  message: string;
  target?: "communication-identity";
};
type UpdateRihdReadiness = {
  ready: boolean;
  code: "ready" | "invalid_state" | "odoo_mapping_missing" | "po_lines_missing" | "update_in_flight" | "erp_connector_unavailable";
  message: string;
  target?: "connector-erp";
};
type MarkAtRiskReadiness = {
  ready: boolean;
  code: "ready" | "invalid_state" | "already_marked";
  message: string;
  exceptionId?: string;
};
type ManualRiskSeverity = "medium" | "high" | "critical";
type ManualRiskCategory = "supplier_response" | "schedule" | "production" | "logistics" | "quality" | "commercial" | "compliance" | "other";
type RouteEvidenceCandidate = {
  id: string; type: "erp_field" | "route_document"; evidenceType: "erp_field" | "contract" | "incoterm"; eligible: boolean;
  reference: string; label: string; summary: string; sourceSystem: string;
  sourceEntity: "purchase_order" | "supplier" | "route_document"; supplierId?: string; supplierVersion?: number; purchaseOrderId: string;
  purchaseOrderVersion: number; observedAt: string;
  fields: {
    incotermId?: number; incotermName?: string; incotermLocation?: string; countryCode?: string; countryName?: string;
    city?: string; street?: string; street2?: string; postalCode?: string; documentId?: string; businessReference?: string;
    documentVersion?: number; attachmentId?: string; attachmentVersion?: number; sha256?: string; fileName?: string; sizeBytes?: number;
    securityStatus?: string; processingStatus?: string; detectedContentType?: string;
  };
};
type ExistingAttachment = {
  id: string; fileName: string; sizeBytes: number; sha256: string; version: number;
  securityStatus: string; processingStatus: string; eligible: boolean; contentUrl?: string; extractedTextPreview?: string;
};
type RouteEvidenceDocument = {
  id: string; evidenceType: "contract" | "incoterm"; businessReference: string; status: "active" | "revoked";
  version: number; attachmentId: string; fileName: string; attachmentVersion: number; sha256: string; contentUrl?: string;
};
type RouteEvidencePayload = {
  purchaseOrderId: string; clamAvConfigured: boolean; documents: RouteEvidenceDocument[];
  availableAttachments: ExistingAttachment[]; events: Array<Record<string, unknown>>;
  permissions: { operate: boolean; configure: boolean };
};
type PortfolioItem = {
  id: string; version: number; number: string; supplierId: string; supplierName: string; route: Route; routeSource: "manual" | "erp_field" | "unclassified";
  routeAssignmentVersion: number; routeEvidence: Record<string, unknown>; routeEvidenceCandidates: RouteEvidenceCandidate[]; routeRiskBucket: RouteRiskBucket;
  materialType: string; status: string; stage: string; stageLabel: string; requiredInHouseAt: string | null;
  overdueDays: number; risk: Risk; riskScore: number; riskFactors: PortfolioRiskFactor[]; nextAction: string; currency: string; amountTotal: number; active: boolean;
  actionReadiness: { queue_followup: FollowupReadiness; update_rihd: UpdateRihdReadiness; mark_at_risk: MarkAtRiskReadiness };
  lastActivityAt?: string | null;
  shipmentCount: number; receiptCount: number;
  transportEventCount: number;
  latestShipment: null | { id: string; externalId: string; shippedAt: string; estimatedArrivalAt: string | null; carrier: string | null; trackingNumber: string | null; sourceSystem: string; evidenceSource: string | null };
  latestTransportEvent: null | { id: string; externalId: string; shipmentId: string; eventCode: string; occurredAt: string; location: string | null; estimatedArrivalAt: string | null; carrierReference: string | null; evidenceSource: string };
  customsStatus: string | null;
  latestReceipt: null | { id: string; externalId: string; receivedAt: string; warehouseId: string; sourceSystem: string; evidenceSource: string | null };
  importDocumentEvaluation: null | { status: string; updatedAt: string; summary: Record<string, unknown> };
};
type RouteSummary = RouteRiskSummary;
type Portfolio = {
  generatedAt: string;
  metrics: { unclassifiedRoute: number };
  routes: Record<Route, RouteSummary>;
  items: PortfolioItem[];
};
type WorkbenchPayload = { portfolio?: Portfolio; permissions?: { operate?: boolean; approve?: boolean; configure?: boolean } };
type FollowupDraftResult = { id: string; status: "draft"; version: number; subject: string; recipient: string; category: string };
type RihdOutboxResult = {
  id: string;
  status: "blocked" | "pending" | "processing" | "dispatched" | "failed";
  error?: string;
};
type ManualRiskResult = {
  id: string;
  type: "manual_purchase_order_risk";
  severity: ManualRiskSeverity;
  status: "assigned";
  createdAt: string;
};
type RouteExportResult = {
  id: string; route: "local" | "import"; sourceWatermark: string; rowCount: number; contentSha256: string;
  state: "ready"; createdAt: string; expiresAt: string; downloadUrl: string; replayed: boolean;
};

const emptySummary: RouteSummary = { total: 0, high: 0, awaitingSupplier: 0, deliveryRisk: 0, onTrack: 0 };
const riskLabels: Record<Risk, string> = { high: "高", medium: "中", low: "低" };
const riskTone: Record<Risk, string> = { high: "bg-red-50 text-red-600", medium: "bg-amber-50 text-amber-700", low: "bg-emerald-50 text-emerald-700" };
const manualRiskLabels: Record<ManualRiskSeverity, string> = { medium: "中风险", high: "高风险", critical: "严重风险" };
const manualRiskCategoryLabels: Record<ManualRiskCategory, string> = {
  supplier_response: "供应商响应", schedule: "计划与交期", production: "生产 / 备货", logistics: "物流与运输",
  quality: "质量", commercial: "价格与商务", compliance: "合规与单证", other: "其他",
};
const PAGE_SIZE = 10;

function RouteWorkbenchDialog({
  children,
  className,
  isLocked,
  onClose,
  returnFocusRef,
  titleId,
}: {
  children: React.ReactNode;
  className: string;
  isLocked: () => boolean;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  titleId: string;
}) {
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !isLocked()) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-sm" />
      <Dialog.Content
        aria-labelledby={titleId}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocusRef.current;
          if (target?.isConnected) target.focus();
          returnFocusRef.current = null;
        }}
        onEscapeKeyDown={(event) => { if (isLocked()) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (isLocked()) event.preventDefault(); }}
        className={cn("fixed left-1/2 top-1/2 z-[51] max-h-[calc(100vh-32px)] w-[calc(100%-32px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[24px] border border-white/60 bg-white p-6 shadow-2xl outline-none", className)}
      >
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

type RouteStageTab = { id: string; label: string };

function routeStageTabs(route: "local" | "import"): RouteStageTab[] {
  return route === "local"
    ? [
        { id: "all", label: "全部采购订单" },
        { id: "po_sent", label: "采购订单已发送" },
        { id: "supplier_commitment", label: "供应商承诺" },
        { id: "fulfilment_production", label: "履约 / 生产" },
        { id: "dispatch_transit", label: "发运" },
        { id: "delivery_grn", label: "交付" },
        { id: "completed", label: "已完成" },
      ]
    : [
        { id: "all", label: "全部采购订单" },
        { id: "po_sent", label: "采购订单已发送" },
        { id: "supplier_commitment", label: "供应商承诺" },
        { id: "fulfilment_production", label: "履约 / 生产" },
        { id: "dispatch_transit", label: "在途跟踪" },
        { id: "delivery_grn", label: "交付完成与收货" },
        { id: "completed", label: "已完成" },
      ];
}

function errorText(error: unknown): string {
  if (error instanceof ReadyworkApiError) return error.message;
  return error instanceof Error ? error.message : "采购路线数据读取失败";
}
function isUncertainMutationError(error: unknown): boolean {
  return error instanceof ReadyworkApiError && [0, 408, 500, 503].includes(error.status);
}
function formatMoney(value: number, currency: string): string {
  try { return new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 }).format(value); }
  catch { return `${currency} ${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`; }
}
function daysToRihd(value: string | null): number | null {
  if (!value) return null;
  const target = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (!Number.isFinite(target.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}
async function fileBase64(file: File): Promise<string> { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 8192))); return btoa(binary); }
function documentCandidateStatus(candidate: RouteEvidenceCandidate): { label: string; tone: string } {
  if (candidate.eligible) return { label: "可用于确认", tone: "bg-emerald-50 text-emerald-700" };
  if (candidate.fields.securityStatus === "quarantined") return { label: "已隔离", tone: "bg-red-50 text-red-700" };
  if (candidate.fields.securityStatus !== "clean") return { label: "安全扫描中", tone: "bg-amber-50 text-amber-700" };
  if (candidate.fields.processingStatus !== "parsed") return { label: "解析中", tone: "bg-amber-50 text-amber-700" };
  return { label: "暂不可用", tone: "bg-slate-100 text-slate-600" };
}

export function ProcurementRouteWorkbench({ route, onOpenOrder, onOpenMessageDrafts }: {
  route: "local" | "import";
  onOpenOrder: (poId: string) => void;
  onOpenMessageDrafts?: (draftId: string) => void;
}) {
  const { formatDate: formatTenantDate, formatShortDateTime } = useProcurementLocale();
  const formatDate = (value: string | null) => formatTenantDate(value, "未设置");
  const formatDateTime = (value: string | null) => formatShortDateTime(value, "未提供 ETA");
  const [data, setData] = useState<WorkbenchPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<PortfolioItem | null>(null);
  const [targetRoute, setTargetRoute] = useState<"local" | "import">(route);
  const [evidenceType, setEvidenceType] = useState<RouteEvidenceType>("contract");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [evidenceNotes, setEvidenceNotes] = useState("");
  const [evidenceBusinessReference, setEvidenceBusinessReference] = useState("");
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [uploadingEvidence, setUploadingEvidence] = useState(false);
  const [routeEvidenceData, setRouteEvidenceData] = useState<RouteEvidencePayload | null>(null);
  const [routeEvidenceLoading, setRouteEvidenceLoading] = useState(false);
  const [selectedExistingAttachmentId, setSelectedExistingAttachmentId] = useState("");
  const [existingBusinessReference, setExistingBusinessReference] = useState("");
  const [bindingEvidence, setBindingEvidence] = useState(false);
  const [revokingEvidenceId, setRevokingEvidenceId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [routeDialogError, setRouteDialogError] = useState<string | null>(null);
  const [syncingRouteSources, setSyncingRouteSources] = useState(false);
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState<"all" | Risk>("all");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [assistantMode, setAssistantMode] = useState<"normal" | "expanded" | "closed">("normal");
  const [followupTarget, setFollowupTarget] = useState<PortfolioItem | null>(null);
  const [followupReason, setFollowupReason] = useState("");
  const [followupSubmitting, setFollowupSubmitting] = useState(false);
  const [followupResult, setFollowupResult] = useState<FollowupDraftResult | null>(null);
  const [followupError, setFollowupError] = useState<string | null>(null);
  const [rihdTarget, setRihdTarget] = useState<PortfolioItem | null>(null);
  const [rihdDate, setRihdDate] = useState("");
  const [rihdReason, setRihdReason] = useState("");
  const [rihdSubmitting, setRihdSubmitting] = useState(false);
  const [rihdPolling, setRihdPolling] = useState(false);
  const [rihdOutbox, setRihdOutbox] = useState<RihdOutboxResult | null>(null);
  const [rihdReadbackVerified, setRihdReadbackVerified] = useState(false);
  const [rihdError, setRihdError] = useState<string | null>(null);
  const [riskTarget, setRiskTarget] = useState<PortfolioItem | null>(null);
  const [manualRiskSeverity, setManualRiskSeverity] = useState<ManualRiskSeverity>("high");
  const [manualRiskCategory, setManualRiskCategory] = useState<ManualRiskCategory>("schedule");
  const [manualRiskReason, setManualRiskReason] = useState("");
  const [manualRiskRecommendation, setManualRiskRecommendation] = useState("");
  const [manualRiskSubmitting, setManualRiskSubmitting] = useState(false);
  const [manualRiskResult, setManualRiskResult] = useState<ManualRiskResult | null>(null);
  const [manualRiskError, setManualRiskError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const followupInFlightRef = useRef(false);
  const rihdInFlightRef = useRef(false);
  const rihdPollingInFlightRef = useRef(false);
  const riskInFlightRef = useRef(false);
  const routeSourceSyncInFlightRef = useRef(false);
  const followupKeyRef = useRef<{ payloadSignature: string; key: string } | null>(null);
  const rihdKeyRef = useRef<{ payloadSignature: string; key: string } | null>(null);
  const riskKeyRef = useRef<{ payloadSignature: string; key: string } | null>(null);
  const routeSourceSyncKeyRef = useRef<string | null>(null);
  const uploadEvidenceInFlightRef = useRef(false);
  const bindEvidenceInFlightRef = useRef(false);
  const revokeEvidenceInFlightRef = useRef(false);
  const uploadEvidenceKeyRef = useRef<{ payloadSignature: string; key: string } | null>(null);
  const bindEvidenceKeyRef = useRef<{ payloadSignature: string; key: string } | null>(null);
  const revokeEvidenceKeyRef = useRef<{ payloadSignature: string; key: string } | null>(null);
  const revokeEvidenceReasonRef = useRef<{ documentId: string; reason: string } | null>(null);
  const followupReturnFocusRef = useRef<HTMLElement | null>(null);
  const rihdReturnFocusRef = useRef<HTMLElement | null>(null);
  const riskReturnFocusRef = useRef<HTMLElement | null>(null);
  const routeReturnFocusRef = useRef<HTMLElement | null>(null);
  const exportInFlightRef = useRef(false);
  const exportIdempotencyKeyRef = useRef<{ filterSignature: string; key: string } | null>(null);
  const assignmentInFlightRef = useRef(false);
  const assignmentIdempotencyKeyRef = useRef<{ payloadSignature: string; key: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const load = useCallback(async (): Promise<WorkbenchPayload | null> => {
    abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller; setLoading(true); setError(null);
    try { const result = await apiRequest<WorkbenchPayload>("/api/procurement/workbench?limit=100", { signal: controller.signal }); if (!controller.signal.aborted) setData(result); return result; }
    catch (requestError) { if (!controller.signal.aborted) setError(errorText(requestError)); return null; }
    finally { if (!controller.signal.aborted) setLoading(false); if (abortRef.current === controller) abortRef.current = null; }
  }, []);
  useEffect(() => { void load(); return () => abortRef.current?.abort(); }, [load]);
  useProcurementRealtimeRefresh(["pos", "messages", "outbox"], () => { void load(); });
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useEffect(() => { setTargetRoute(route); }, [route]);

  async function readRouteEvidence(poId: string): Promise<RouteEvidencePayload | null> {
    setRouteEvidenceLoading(true);
    try {
      const result = await apiRequest<RouteEvidencePayload>(`/api/procurement/routes/${encodeURIComponent(poId)}/evidence-documents`);
      setRouteEvidenceData(result);
      return result;
    } catch (requestError) {
      setRouteEvidenceData(null);
      setRouteDialogError(errorText(requestError));
      return null;
    } finally {
      setRouteEvidenceLoading(false);
    }
  }

  const portfolio = data?.portfolio;
  const items = useMemo(() => (portfolio?.items ?? []).filter((item) => item.route === route), [portfolio, route]);
  const filteredItems = useMemo(() => items.filter((item) => {
    if (stageFilter === "completed" && item.active) return false;
    if (stageFilter !== "all" && stageFilter !== "completed" && (!item.active || item.stage !== stageFilter)) return false;
    if (riskFilter !== "all" && item.risk !== riskFilter) return false;
    if (supplierFilter !== "all" && item.supplierId !== supplierFilter) return false;
    const requiredAt = item.requiredInHouseAt ? Date.parse(item.requiredInHouseAt) : Number.NaN;
    if (dateFrom && (!Number.isFinite(requiredAt) || requiredAt < Date.parse(`${dateFrom}T00:00:00`))) return false;
    if (dateTo && (!Number.isFinite(requiredAt) || requiredAt > Date.parse(`${dateTo}T23:59:59.999`))) return false;
    const query = search.trim().toLocaleLowerCase("zh-CN");
    return !query || [item.number, item.supplierName, item.materialType].some((value) => value.toLocaleLowerCase("zh-CN").includes(query));
  }).sort((left, right) => {
    const riskRank: Record<Risk, number> = { high: 0, medium: 1, low: 2 };
    return riskRank[left.risk] - riskRank[right.risk]
      || Date.parse(left.requiredInHouseAt ?? "9999-12-31") - Date.parse(right.requiredInHouseAt ?? "9999-12-31");
  }), [dateFrom, dateTo, items, riskFilter, search, stageFilter, supplierFilter]);
  const unclassified = useMemo(() => (portfolio?.items ?? []).filter((item) => item.active && item.route === "unclassified"), [portfolio]);
  const evidenceCoverage = useMemo(() => routeEvidenceCoverage(portfolio?.items ?? []), [portfolio]);
  const documentManagedItems = useMemo(() => items.filter((item) => item.routeEvidenceCandidates.some((candidate) => candidate.type === "route_document")), [items]);
  const summary = portfolio?.routes?.[route] ?? emptySummary;
  const tabs = useMemo(() => routeStageTabs(route), [route]);
  const supplierOptions = useMemo(() => [...new Map(items.map((item) => [item.supplierId, item.supplierName] as const)).entries()]
    .map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, "zh-CN")), [items]);
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const pageItems = filteredItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const pageNumbers = Array.from({ length: pageCount }, (_, index) => index + 1);
  const routePriorities = useMemo(() => items.filter((item) => item.active).sort((left, right) => right.riskScore - left.riskScore).slice(0, 4), [items]);
  const selectedEvidenceCandidate = selected?.routeEvidenceCandidates.find((candidate) => candidate.reference === evidenceReference);
  const evidenceCandidates = selected?.routeEvidenceCandidates.filter((candidate) => candidate.evidenceType === evidenceType) ?? [];
  const activeEvidenceDocuments = routeEvidenceData?.documents.filter((document) => document.status === "active" && document.evidenceType === evidenceType) ?? [];
  const selectedExistingAttachment = routeEvidenceData?.availableAttachments.find((attachment) => attachment.id === selectedExistingAttachmentId) ?? null;
  const isLocal = route === "local"; const title = isLocal ? "本地采购" : "进口采购"; const RouteIcon = isLocal ? ShoppingCart : Globe2;
  const description = isLocal ? "管理并跟踪所有本地采购订单" : "管理并跟踪所有进口采购订单";

  useEffect(() => {
    setCurrentPage(1);
  }, [dateFrom, dateTo, riskFilter, route, search, stageFilter, supplierFilter]);

  useEffect(() => {
    if (currentPage > pageCount) setCurrentPage(pageCount);
  }, [currentPage, pageCount]);

  useEffect(() => {
    assignmentIdempotencyKeyRef.current = null;
  }, [evidenceNotes, evidenceReference, evidenceType, selected?.id, selected?.routeAssignmentVersion, targetRoute]);

  useEffect(() => {
    exportIdempotencyKeyRef.current = null;
  }, [dateFrom, dateTo, riskFilter, route, search, stageFilter, supplierFilter]);

  useEffect(() => {
    uploadEvidenceKeyRef.current = null;
  }, [evidenceBusinessReference, evidenceFile, evidenceType, selected?.id]);

  useEffect(() => {
    bindEvidenceKeyRef.current = null;
  }, [evidenceType, existingBusinessReference, selected?.id, selectedExistingAttachmentId]);

  useEffect(() => {
    followupKeyRef.current = null;
  }, [followupReason, followupTarget?.id, followupTarget?.version]);

  useEffect(() => {
    rihdKeyRef.current = null;
  }, [rihdDate, rihdReason, rihdTarget?.id, rihdTarget?.version]);

  useEffect(() => {
    riskKeyRef.current = null;
  }, [manualRiskCategory, manualRiskReason, manualRiskRecommendation, manualRiskSeverity, riskTarget?.id, riskTarget?.version]);

  function openClassifier(item: PortfolioItem, returnFocusElement: HTMLElement | null = null) {
    routeReturnFocusRef.current = returnFocusElement;
    const candidate = item.routeEvidenceCandidates.find((entry) => entry.eligible);
    setSelected(item); setTargetRoute(route); setEvidenceType(candidate?.evidenceType ?? "contract");
    setEvidenceReference(candidate?.reference ?? ""); setEvidenceNotes(""); setEvidenceBusinessReference(""); setEvidenceFile(null);
    setRouteEvidenceData(null); setSelectedExistingAttachmentId(""); setExistingBusinessReference(""); setRouteDialogError(null); setError(null); setNotice(null);
    void readRouteEvidence(item.id);
  }
  function closeClassifier() {
    if (assignmentInFlightRef.current || uploadEvidenceInFlightRef.current || bindEvidenceInFlightRef.current || revokeEvidenceInFlightRef.current) return;
    revokeEvidenceReasonRef.current = null;
    revokeEvidenceKeyRef.current = null;
    setRouteDialogError(null);
    setSelected(null);
  }
  function changeEvidenceType(next: RouteEvidenceType) {
    setEvidenceType(next);
    const candidate = selected?.routeEvidenceCandidates.find((entry) => entry.evidenceType === next && entry.eligible);
    setEvidenceReference(candidate?.reference ?? "");
    setEvidenceBusinessReference(""); setEvidenceFile(null); setSelectedExistingAttachmentId(""); setExistingBusinessReference("");
  }
  async function uploadRouteEvidence() {
    if (uploadEvidenceInFlightRef.current || !selected || (evidenceType !== "contract" && evidenceType !== "incoterm") || !evidenceFile || !evidenceBusinessReference.trim()) return;
    if (evidenceFile.size > 8 * 1024 * 1024) { setRouteDialogError("单个文件不能超过 8 MB"); return; }
    const selectedId = selected.id;
    const businessReference = evidenceBusinessReference.trim();
    const file = evidenceFile;
    let requestStarted = false;
    let requestKey = "";
    uploadEvidenceInFlightRef.current = true;
    setUploadingEvidence(true); setRouteDialogError(null); setNotice(null);
    try {
      const body = {
        evidenceType,
        businessReference,
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        contentBase64: await fileBase64(file),
      };
      const payloadSignature = JSON.stringify({ purchaseOrderId: selectedId, ...body });
      const retained = uploadEvidenceKeyRef.current;
      requestKey = retained?.payloadSignature === payloadSignature
        ? retained.key
        : `route-evidence:${selectedId}:${evidenceType}:${crypto.randomUUID()}`;
      uploadEvidenceKeyRef.current = { payloadSignature, key: requestKey };
      requestStarted = true;
      const result = await apiRequest<{ message?: string }>(`/api/procurement/routes/${encodeURIComponent(selectedId)}/evidence-documents`, {
        method: "POST", timeoutMs: 30_000,
        headers: { "Idempotency-Key": requestKey },
        body,
      });
      if (uploadEvidenceKeyRef.current?.key === requestKey) uploadEvidenceKeyRef.current = null;
      setNotice(result.message ?? "证据文件已持久化；明确通过安全与解析门禁前不能用于路线确认。");
      setEvidenceFile(null); setEvidenceBusinessReference("");
      const [refreshed] = await Promise.all([load(), readRouteEvidence(selectedId)]);
      const refreshedItem = refreshed?.portfolio?.items.find((item) => item.id === selectedId) ?? null;
      if (refreshedItem) {
        setSelected(refreshedItem);
        const candidate = refreshedItem.routeEvidenceCandidates.find((entry) => entry.evidenceType === evidenceType && entry.eligible);
        setEvidenceReference(candidate?.reference ?? "");
      }
    } catch (requestError) {
      if ((!requestStarted || !isUncertainMutationError(requestError)) && uploadEvidenceKeyRef.current?.key === requestKey) uploadEvidenceKeyRef.current = null;
      setRouteDialogError(errorText(requestError));
    } finally {
      uploadEvidenceInFlightRef.current = false;
      setUploadingEvidence(false);
    }
  }
  async function bindExistingRouteEvidence() {
    if (bindEvidenceInFlightRef.current || !selected || (evidenceType !== "contract" && evidenceType !== "incoterm")) return;
    const attachment = routeEvidenceData?.availableAttachments.find((item) => item.id === selectedExistingAttachmentId);
    if (!attachment || !attachment.eligible || !existingBusinessReference.trim()) return;
    const selectedId = selected.id;
    const body = {
      evidenceType,
      businessReference: existingBusinessReference.trim(),
      attachmentId: attachment.id,
      expectedAttachmentVersion: attachment.version,
      expectedSha256: attachment.sha256,
    };
    const payloadSignature = JSON.stringify({ purchaseOrderId: selectedId, ...body });
    const retained = bindEvidenceKeyRef.current;
    const requestKey = retained?.payloadSignature === payloadSignature
      ? retained.key
      : `route-evidence-bind:${selectedId}:${attachment.id}:${crypto.randomUUID()}`;
    bindEvidenceKeyRef.current = { payloadSignature, key: requestKey };
    bindEvidenceInFlightRef.current = true;
    setBindingEvidence(true); setRouteDialogError(null); setNotice(null);
    try {
      const result = await apiRequest<{ item: RouteEvidenceDocument; message: string }>(`/api/procurement/routes/${encodeURIComponent(selectedId)}/evidence-documents/bind`, {
        method: "POST",
        headers: { "Idempotency-Key": requestKey },
        body,
      });
      if (bindEvidenceKeyRef.current?.key === requestKey) bindEvidenceKeyRef.current = null;
      setSelectedExistingAttachmentId(""); setExistingBusinessReference(""); setNotice(result.message);
      const [refreshed] = await Promise.all([load(), readRouteEvidence(selectedId)]);
      const refreshedItem = refreshed?.portfolio?.items.find((item) => item.id === selectedId) ?? null;
      if (refreshedItem) {
        setSelected(refreshedItem);
        const candidate = refreshedItem.routeEvidenceCandidates.find((entry) => entry.fields.documentId === result.item.id && entry.eligible);
        setEvidenceReference(candidate?.reference ?? "");
      }
    } catch (requestError) {
      if (!isUncertainMutationError(requestError) && bindEvidenceKeyRef.current?.key === requestKey) bindEvidenceKeyRef.current = null;
      setRouteDialogError(errorText(requestError));
    } finally {
      bindEvidenceInFlightRef.current = false;
      setBindingEvidence(false);
    }
  }
  async function revokeRouteEvidence(document: RouteEvidenceDocument) {
    if (revokeEvidenceInFlightRef.current || !selected || document.status !== "active") return;
    const retainedReason = revokeEvidenceReasonRef.current?.documentId === document.id ? revokeEvidenceReasonRef.current.reason : "";
    const reason = uiPrompt(`请输入撤销 ${document.businessReference} 的原因（必填）`, retainedReason);
    if (reason === null) return;
    if (reason.trim().length < 2) { setRouteDialogError("撤销原因至少需要 2 个字符"); return; }
    const selectedId = selected.id;
    const normalizedReason = reason.trim();
    revokeEvidenceReasonRef.current = { documentId: document.id, reason: normalizedReason };
    const body = { expectedVersion: document.version, reason: normalizedReason };
    const payloadSignature = JSON.stringify({ purchaseOrderId: selectedId, documentId: document.id, ...body });
    const retained = revokeEvidenceKeyRef.current;
    const requestKey = retained?.payloadSignature === payloadSignature
      ? retained.key
      : `route-evidence-revoke:${selectedId}:${document.id}:${crypto.randomUUID()}`;
    revokeEvidenceKeyRef.current = { payloadSignature, key: requestKey };
    revokeEvidenceInFlightRef.current = true;
    setRevokingEvidenceId(document.id); setRouteDialogError(null); setNotice(null);
    try {
      const result = await apiRequest<{ routeUnclassified: boolean; message: string }>(`/api/procurement/routes/${encodeURIComponent(selectedId)}/evidence-documents/${encodeURIComponent(document.id)}`, {
        method: "DELETE",
        headers: { "Idempotency-Key": requestKey },
        body,
      });
      revokeEvidenceKeyRef.current = null;
      revokeEvidenceReasonRef.current = null;
      const [refreshed] = await Promise.all([load(), readRouteEvidence(selectedId)]);
      setNotice(result.message);
      if (result.routeUnclassified) {
        setSelected(null); setRouteEvidenceData(null); setEvidenceReference("");
      } else {
        const refreshedItem = refreshed?.portfolio?.items.find((item) => item.id === selectedId) ?? null;
        if (refreshedItem) {
          setSelected(refreshedItem);
          const candidate = refreshedItem.routeEvidenceCandidates.find((entry) => entry.evidenceType === evidenceType && entry.eligible);
          setEvidenceReference(candidate?.reference ?? "");
        }
      }
    } catch (requestError) {
      if (!isUncertainMutationError(requestError) && revokeEvidenceKeyRef.current?.key === requestKey) revokeEvidenceKeyRef.current = null;
      setRouteDialogError(errorText(requestError));
    } finally {
      revokeEvidenceInFlightRef.current = false;
      setRevokingEvidenceId(null);
    }
  }
  async function assignRoute() {
    const reference = evidenceReference.trim();
    if (!selected || assignmentInFlightRef.current || !reference) return;
    const body = {
      route: targetRoute,
      evidence: { type: evidenceType, reference, notes: evidenceNotes.trim() || undefined, reason: evidenceNotes.trim() || reference },
      expectedVersion: selected.routeAssignmentVersion,
    };
    const payloadSignature = JSON.stringify({ poId: selected.id, ...body });
    const retained = assignmentIdempotencyKeyRef.current;
    const key = retained?.payloadSignature === payloadSignature
      ? retained.key
      : `route-assignment:${selected.id}:${crypto.randomUUID()}`;
    assignmentIdempotencyKeyRef.current = { payloadSignature, key };
    assignmentInFlightRef.current = true;
    setSaving(true); setRouteDialogError(null); setNotice(null);
    try {
      await apiRequest(`/api/procurement/routes/${encodeURIComponent(selected.id)}/assign`, {
        method: "POST", headers: { "Idempotency-Key": key }, body,
      });
      assignmentIdempotencyKeyRef.current = null;
      setSelected(null); setNotice(`${selected.number} 已持久化为${targetRoute === "local" ? "本地采购" : "进口采购"}，审计记录已生成。`); await load();
    } catch (requestError) {
      if (!isUncertainMutationError(requestError) && assignmentIdempotencyKeyRef.current?.key === key) assignmentIdempotencyKeyRef.current = null;
      setRouteDialogError(errorText(requestError));
    }
    finally { assignmentInFlightRef.current = false; setSaving(false); }
  }

  async function syncOdooRouteSources() {
    if (routeSourceSyncInFlightRef.current) return;
    const idempotencyKey = routeSourceSyncKeyRef.current ?? `route-evidence-source-sync:${crypto.randomUUID()}`;
    routeSourceSyncKeyRef.current = idempotencyKey;
    routeSourceSyncInFlightRef.current = true;
    setSyncingRouteSources(true); setError(null); setNotice(null);
    try {
      const result = await apiRequest<SupplierMasterSyncResult>("/api/procurement/suppliers/sync", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: { idempotencyKey },
      });
      if (routeSourceSyncKeyRef.current === idempotencyKey) routeSourceSyncKeyRef.current = null;
      const refreshed = await load();
      const coverage = routeEvidenceCoverage(refreshed?.portfolio?.items ?? []);
      setNotice(supplierRouteEvidenceSyncMessage(result, coverage));
    } catch (requestError) {
      if (!isUncertainMutationError(requestError) && routeSourceSyncKeyRef.current === idempotencyKey) routeSourceSyncKeyRef.current = null;
      setError(errorText(requestError));
    } finally {
      routeSourceSyncInFlightRef.current = false;
      setSyncingRouteSources(false);
    }
  }

  function defaultFollowupReason(item: PortfolioItem): string {
    if (item.stage === "supplier_commitment") return "请确认已收到采购订单，并逐行回复数量、单价和承诺交期";
    if (item.stage === "fulfilment_production") return "请更新当前生产或备货完成度、预计可发运日期及已知风险";
    if (item.stage === "dispatch_transit") return "请更新发运批次、运输单号、最新 ETA 及异常情况";
    if (item.stage === "delivery_grn") return "请确认剩余到货数量与最终交付计划";
    return "请更新当前采购订单的执行进度、下一承诺节点及已知风险";
  }

  function openFollowupDialog(item: PortfolioItem, returnFocusElement: HTMLElement | null = null) {
    followupReturnFocusRef.current = returnFocusElement;
    setFollowupTarget(item);
    setFollowupReason(defaultFollowupReason(item));
    setFollowupResult(null);
    setFollowupError(null);
    setError(null);
  }

  function closeFollowupDialog() {
    if (followupInFlightRef.current) return;
    followupKeyRef.current = null;
    setFollowupTarget(null);
    setFollowupReason("");
    setFollowupResult(null);
    setFollowupError(null);
  }

  async function createFollowupDraft() {
    if (!followupTarget || followupInFlightRef.current || !followupTarget.actionReadiness.queue_followup.ready || !data?.permissions?.operate) return;
    const reason = followupReason.trim();
    if (reason.length < 4) { setFollowupError("跟进要求至少需要 4 个字符"); return; }
    const body = { aggregateId: followupTarget.id, expectedVersion: followupTarget.version, connectorId: "email", reason };
    const payloadSignature = JSON.stringify(body);
    const retained = followupKeyRef.current;
    const requestKey = retained?.payloadSignature === payloadSignature
      ? retained.key
      : `route-followup:${followupTarget.id}:v${followupTarget.version}:${crypto.randomUUID()}`;
    followupKeyRef.current = { payloadSignature, key: requestKey };
    followupInFlightRef.current = true;
    setFollowupSubmitting(true); setFollowupError(null); setNotice(null);
    try {
      const result = await apiRequest<{ messageDraft: FollowupDraftResult }>("/api/procurement/execution/queue_followup", {
        method: "POST",
        headers: { "Idempotency-Key": requestKey },
        body,
      });
      if (followupKeyRef.current?.key === requestKey) followupKeyRef.current = null;
      setFollowupResult(result.messageDraft);
      setNotice(`${followupTarget.number} 的跟进草稿已持久化；尚未发送，需要在草稿邮件中审核。`);
      await load();
    } catch (requestError) {
      if (!isUncertainMutationError(requestError) && followupKeyRef.current?.key === requestKey) followupKeyRef.current = null;
      setFollowupError(errorText(requestError));
    } finally {
      followupInFlightRef.current = false;
      setFollowupSubmitting(false);
    }
  }

  function openRihdDialog(item: PortfolioItem, returnFocusElement: HTMLElement | null = null) {
    rihdReturnFocusRef.current = returnFocusElement;
    setRihdTarget(item);
    setRihdDate(item.requiredInHouseAt?.slice(0, 10) ?? "");
    setRihdReason("");
    setRihdOutbox(null);
    setRihdReadbackVerified(false);
    setRihdError(null);
    rihdKeyRef.current = null;
  }

  function closeRihdDialog() {
    if (rihdInFlightRef.current || rihdPollingInFlightRef.current) return;
    setRihdTarget(null);
    setRihdDate("");
    setRihdReason("");
    setRihdOutbox(null);
    setRihdReadbackVerified(false);
    setRihdError(null);
    rihdKeyRef.current = null;
  }

  async function verifyRihdReadback(): Promise<boolean> {
    const targetId = rihdTarget?.id;
    if (!targetId) return false;
    try {
      const refreshed = await apiRequest<WorkbenchPayload>("/api/procurement/workbench?limit=100");
      setData(refreshed);
      const refreshedItem = refreshed.portfolio?.items.find((item) => item.id === targetId);
      if (refreshedItem?.requiredInHouseAt?.slice(0, 10) === rihdDate) {
        setRihdTarget(refreshedItem);
        setRihdReadbackVerified(true);
        setRihdError(null);
        setNotice(`${refreshedItem.number} 的 RIHD 已经 Odoo 写入、回读核验并持久化。`);
        return true;
      }
      setRihdReadbackVerified(false);
      setRihdError("Odoo 回执已提交，但权威 RIHD 回读尚未确认；页面继续显示上次已确认值。");
      return false;
    } catch (requestError) {
      setRihdReadbackVerified(false);
      setRihdError(`Odoo 回执已提交，但权威 RIHD 回读尚未确认：${errorText(requestError)}`);
      return false;
    }
  }

  async function refreshRihdOutbox(outboxId: string, attempts = 1): Promise<void> {
    if (rihdPollingInFlightRef.current) return;
    rihdPollingInFlightRef.current = true;
    setRihdPolling(true);
    setRihdError(null);
    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        const result = await apiRequest<{ items: RihdOutboxResult[] }>("/api/procurement/execution/outbox");
        const current = result.items.find((item) => item.id === outboxId);
        if (!current) throw new Error("RIHD 发件箱回执不存在");
        setRihdOutbox(current);
        if (current.status === "dispatched") {
          await verifyRihdReadback();
          return;
        }
        if (current.status === "failed" || current.status === "blocked") return;
      }
    } catch (requestError) {
      setRihdError(errorText(requestError));
    } finally {
      rihdPollingInFlightRef.current = false;
      setRihdPolling(false);
    }
  }

  async function submitRihdUpdate() {
    if (!rihdTarget || rihdInFlightRef.current || !rihdTarget.actionReadiness.update_rihd.ready || !data?.permissions?.approve) return;
    if (!rihdDate) { setRihdError("请选择新的 RIHD"); return; }
    if (rihdDate === rihdTarget.requiredInHouseAt?.slice(0, 10)) { setRihdError("新 RIHD 不能与当前日期相同"); return; }
    const reason = rihdReason.trim();
    if (reason.length < 4) { setRihdError("修改原因至少需要 4 个字符"); return; }
    const body = {
      aggregateId: rihdTarget.id,
      expectedVersion: rihdTarget.version,
      connectorId: "erp",
      requiredInHouseAt: rihdDate,
      reason,
    };
    const payloadSignature = JSON.stringify(body);
    const retained = rihdKeyRef.current;
    const requestKey = retained?.payloadSignature === payloadSignature
      ? retained.key
      : `route-rihd:${rihdTarget.id}:v${rihdTarget.version}:${crypto.randomUUID()}`;
    rihdKeyRef.current = { payloadSignature, key: requestKey };
    rihdInFlightRef.current = true;
    setRihdSubmitting(true); setRihdError(null); setNotice(null);
    try {
      const result = await apiRequest<{ outbox: RihdOutboxResult }>("/api/procurement/execution/update_rihd", {
        method: "POST",
        headers: { "Idempotency-Key": requestKey },
        body,
      });
      if (rihdKeyRef.current?.key === requestKey) rihdKeyRef.current = null;
      setRihdOutbox(result.outbox);
      setRihdReadbackVerified(false);
      if (result.outbox.status === "pending" || result.outbox.status === "processing") {
        await refreshRihdOutbox(result.outbox.id, 7);
      } else if (result.outbox.status === "dispatched") {
        await verifyRihdReadback();
      }
    } catch (requestError) {
      if (!isUncertainMutationError(requestError) && rihdKeyRef.current?.key === requestKey) rihdKeyRef.current = null;
      setRihdError(errorText(requestError));
    } finally {
      rihdInFlightRef.current = false;
      setRihdSubmitting(false);
    }
  }

  function defaultManualRiskCategory(item: PortfolioItem): ManualRiskCategory {
    if (item.stage === "supplier_commitment") return "supplier_response";
    if (item.stage === "fulfilment_production") return "production";
    if (item.stage === "dispatch_transit" || item.stage === "delivery_grn") return "logistics";
    return "schedule";
  }

  function openRiskDialog(item: PortfolioItem, returnFocusElement: HTMLElement | null = null) {
    riskReturnFocusRef.current = returnFocusElement;
    setRiskTarget(item);
    setManualRiskSeverity(item.risk === "high" ? "high" : "medium");
    setManualRiskCategory(defaultManualRiskCategory(item));
    setManualRiskReason("");
    setManualRiskRecommendation("");
    setManualRiskResult(null);
    setManualRiskError(null);
  }

  function closeRiskDialog() {
    if (riskInFlightRef.current) return;
    riskKeyRef.current = null;
    setRiskTarget(null);
    setManualRiskReason("");
    setManualRiskRecommendation("");
    setManualRiskResult(null);
    setManualRiskError(null);
  }

  async function submitManualRisk() {
    if (!riskTarget || riskInFlightRef.current || !riskTarget.actionReadiness.mark_at_risk.ready || !data?.permissions?.operate) return;
    const reason = manualRiskReason.trim();
    const recommendedAction = manualRiskRecommendation.trim();
    if (reason.length < 4) { setManualRiskError("风险原因至少需要 4 个字符"); return; }
    if (recommendedAction && recommendedAction.length < 4) { setManualRiskError("处置建议至少需要 4 个字符，或留空使用系统默认建议"); return; }
    const body = {
      aggregateId: riskTarget.id,
      expectedVersion: riskTarget.version,
      riskSeverity: manualRiskSeverity,
      riskCategory: manualRiskCategory,
      reason,
      ...(recommendedAction ? { recommendedAction } : {}),
    };
    const payloadSignature = JSON.stringify(body);
    const retained = riskKeyRef.current;
    const requestKey = retained?.payloadSignature === payloadSignature
      ? retained.key
      : `route-risk:${riskTarget.id}:v${riskTarget.version}:${crypto.randomUUID()}`;
    riskKeyRef.current = { payloadSignature, key: requestKey };
    riskInFlightRef.current = true;
    setManualRiskSubmitting(true); setManualRiskError(null); setNotice(null);
    try {
      const result = await apiRequest<{ exception: ManualRiskResult }>("/api/procurement/execution/mark_at_risk", {
        method: "POST",
        headers: { "Idempotency-Key": requestKey },
        body,
      });
      if (riskKeyRef.current?.key === requestKey) riskKeyRef.current = null;
      setManualRiskResult(result.exception);
      setNotice(`${riskTarget.number} 已写入人工风险事实、统一异常和审计时间线。`);
      const refreshed = await load();
      const refreshedItem = refreshed?.portfolio?.items.find((item) => item.id === riskTarget.id);
      if (refreshedItem) setRiskTarget(refreshedItem);
    } catch (requestError) {
      if (!isUncertainMutationError(requestError) && riskKeyRef.current?.key === requestKey) riskKeyRef.current = null;
      setManualRiskError(errorText(requestError));
    } finally {
      riskInFlightRef.current = false;
      setManualRiskSubmitting(false);
    }
  }

  async function exportFilteredOrders() {
    if (exportInFlightRef.current || filteredItems.length === 0) return;
    const filters = {
      query: search.trim(),
      stages: stageFilter === "all" ? [] : [stageFilter],
      risks: riskFilter === "all" ? [] : [riskFilter],
      supplierIds: supplierFilter === "all" ? [] : [supplierFilter],
      rihdFrom: dateFrom || null,
      rihdTo: dateTo || null,
      sort: "risk_desc",
    };
    const filterSignature = JSON.stringify({ route, ...filters });
    const retained = exportIdempotencyKeyRef.current;
    const key = retained?.filterSignature === filterSignature
      ? retained.key
      : `route-export:${route}:${crypto.randomUUID()}`;
    exportIdempotencyKeyRef.current = { filterSignature, key };
    exportInFlightRef.current = true;
    setExporting(true); setError(null); setNotice(null);
    try {
      const result = await apiRequest<RouteExportResult>(`/api/procurement/routes/${route}/exports`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        body: filters,
      });
      if (exportIdempotencyKeyRef.current?.key === key) exportIdempotencyKeyRef.current = null;
      const anchor = document.createElement("a");
      anchor.href = result.downloadUrl;
      anchor.rel = "noopener";
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setNotice(`已生成 ${result.rowCount} 条权威导出；SHA-256 ${result.contentSha256.slice(0, 12)}…`);
    } catch (requestError) {
      const uncertain = requestError instanceof ReadyworkApiError && [0, 408, 500, 503].includes(requestError.status);
      if (!uncertain && exportIdempotencyKeyRef.current?.key === key) exportIdempotencyKeyRef.current = null;
      setError(errorText(requestError));
    } finally {
      exportInFlightRef.current = false;
      setExporting(false);
    }
  }

  return <div
    aria-busy={loading}
    aria-label={loading && !portfolio ? `${title}加载中` : undefined}
    className={cn(READYWORK_PAGE_CONTAINER_CLASS, "-mt-3 pb-12")}
  >
    <header className="flex h-[76px] items-start border-b border-[#e4e8ef] pb-5">
      <div>
        <h1 className={READYWORK_PAGE_TITLE_CLASS}>{title}</h1>
        <p className="mt-1.5 text-[13.5px] text-[#6f7888]">{description}</p>
      </div>
    </header>
    {error && <div role="alert" data-watermark={portfolio?.generatedAt} className={cn("mt-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700", portfolio ? "flex items-start gap-2 rounded-xl" : "flex min-h-[150px] flex-col items-center justify-center rounded-[22px] text-center")}><AlertCircle className={cn("shrink-0", portfolio ? "mt-0.5 size-4" : "size-8")} /><div><div className={cn("font-bold", portfolio ? "text-sm" : "mt-3 text-base text-[#273247]")}>采购路线读取失败</div><div className="mt-1 leading-6">{error}</div>{portfolio ? <p className="mt-1 text-xs text-red-700">显示的是上次成功数据 · 水位 {formatDateTime(portfolio.generatedAt)}</p> : <p className="mt-2 text-xs text-[#8a92a1]">当前无法确认真实订单数量，因此不会显示“0 张采购订单”的空态。</p>}</div>{!portfolio && <button type="button" onClick={() => void load()} disabled={loading} className="mt-5 flex h-10 items-center gap-2 rounded-xl bg-[#253a67] px-5 text-xs font-semibold text-white disabled:opacity-50"><RefreshCw className={cn("size-4", loading && "animate-spin")} />重新读取</button>}</div>}
    {notice && <div className="mt-4 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"><CheckCircle2 className="mt-0.5 size-4 shrink-0" />{notice}</div>}

    <section className={cn(
      "relative mt-[46px] grid items-start gap-5",
      assistantMode === "closed" ? "grid-cols-1" : assistantMode === "expanded" ? "grid-cols-[minmax(500px,0.95fr)_minmax(0,1.05fr)]" : "grid-cols-[380px_minmax(0,1fr)]",
    )}>
      {assistantMode !== "closed" && <aside className="sticky top-[100px] flex h-[calc(100vh-176px)] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-[#e0e5ed] bg-white shadow-[0_3px_16px_rgba(24,35,54,0.05)]" aria-label={`${title}路线助理`}>
        <RouteChat route={route} mode={assistantMode === "expanded" ? "expanded" : "normal"} onToggleExpand={() => setAssistantMode((mode) => mode === "expanded" ? "normal" : "expanded")} onClose={() => setAssistantMode("closed")} />
      </aside>}

      <div className="min-w-0 overflow-hidden rounded-2xl border border-[#e0e5ed] bg-white shadow-[0_3px_16px_rgba(24,35,54,0.05)]">
        <div className="overflow-x-auto border-b border-[#e6eaf0] px-5 pt-2">
          <div className="flex min-w-max items-center gap-1">
            {tabs.map((tab) => <button key={tab.id} type="button" onClick={() => setStageFilter(tab.id)} className={cn("relative h-12 px-3 text-[11px] font-semibold transition", stageFilter === tab.id ? "text-[#2563eb]" : "text-[#737d8d] hover:text-[#334056]")}>{tab.label}{stageFilter === tab.id && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-[#2563eb]" />}</button>)}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-[#edf0f4] px-5 pb-3 pt-4">
          <label className="relative w-[246px] shrink-0"><Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[#9aa2b0]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索采购订单号、供应商…" className="h-9 w-full rounded-full border border-[#dfe3eb] bg-white pl-9 pr-3 text-[11px] outline-none focus:border-blue-400" /></label>
          <button type="button" onClick={() => { setSearch(""); setRiskFilter("all"); setSupplierFilter("all"); setDateFrom(""); setDateTo(""); }} className={cn("flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[10px] font-semibold transition", search || riskFilter !== "all" || supplierFilter !== "all" || dateFrom || dateTo ? "border-blue-300 bg-blue-50 text-blue-700" : "border-[#dfe3eb] bg-white text-[#5d6879] hover:border-blue-200 hover:text-blue-700")}><Filter className="size-3.5" />筛选</button>
          <RouteFilterMenu label="风险" value={riskFilter} options={(["high", "medium", "low"] as Risk[]).map((risk) => ({ id: risk, label: riskLabels[risk] }))} onChange={(value) => setRiskFilter(value as "all" | Risk)} />
          <RouteFilterMenu label="供应商" value={supplierFilter} options={supplierOptions.map((supplier) => ({ id: supplier.id, label: supplier.name }))} onChange={setSupplierFilter} />
          <RouteDateRangeFilter from={dateFrom} to={dateTo} onApply={(value) => { setDateFrom(value.from); setDateTo(value.to); }} />
          {data?.permissions?.operate === true && <button type="button" aria-busy={exporting} onClick={() => void exportFilteredOrders()} disabled={filteredItems.length === 0 || exporting} className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-[#dfe3eb] bg-white px-3 text-[10px] font-semibold text-[#5d6879] disabled:opacity-40">{exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}<span>导出</span></button>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1140px] text-left">
            <thead><tr className="bg-[#fafbfc] text-[9px] font-semibold uppercase tracking-[0.08em] text-[#939aa8]"><th className="px-5 py-3.5">采购订单号</th><th className="px-4 py-3.5">供应商</th><th className="px-4 py-3.5">物料类型</th><th className="px-4 py-3.5">当前阶段</th><th className="px-4 py-3.5">要求到货日期（RIHD）</th><th className="px-4 py-3.5">距 RIHD 天数</th><th className="px-4 py-3.5">风险</th><th className="px-4 py-3.5">下一步操作</th><th className="px-4 py-3.5">总金额</th><th aria-label="行操作" className="w-12 px-2 py-3.5" /></tr></thead>
            <tbody data-loading={!portfolio ? "true" : undefined} className="[&>tr:nth-child(even)]:bg-[#fcfdff]">
              {!portfolio ? Array.from({ length: 5 }, (_, row) => <tr key={`route-skeleton-${row}`} aria-hidden="true" className="border-t border-[#eef1f5]">{Array.from({ length: 10 }, (_, column) => <td key={column} className="px-4 py-4"><span className="block h-3 animate-pulse rounded-full bg-slate-100" /></td>)}</tr>) : pageItems.map((item) => { const remainingDays = daysToRihd(item.requiredInHouseAt); const riskReason = routeRiskReason(item.riskFactors); const materialType = routeMaterialTypeLabel(item.materialType); const stageLabel = item.active ? routeStageLabel(item.stage, item.stageLabel) : "已完成"; return <tr key={item.id} onClick={() => onOpenOrder(item.id)} className="group cursor-pointer border-t border-[#eef1f5] text-[11px] text-[#5e6879] transition hover:bg-[#f5f8ff]"><td className="px-5 py-3.5 font-bold text-[#2563eb]">{item.number}</td><td data-preserve-language className="max-w-[160px] truncate px-4 py-3.5">{item.supplierName}</td><td className="max-w-[160px] truncate px-4 py-3.5"><span data-preserve-language={materialType === item.materialType ? true : undefined} className="rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">{materialType}</span></td><td className="px-4 py-3.5"><span data-preserve-language={stageLabel === item.stageLabel ? true : undefined} className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-slate-600">{stageLabel}</span></td><td className={cn("whitespace-nowrap px-4 py-3.5", item.overdueDays > 0 && item.active ? "font-semibold text-red-600" : "text-amber-800")}>{formatDate(item.requiredInHouseAt)}</td><td className={cn("whitespace-nowrap px-4 py-3.5 font-semibold", remainingDays !== null && remainingDays < 0 ? "text-red-600" : "text-[#4d5b70]")}>{remainingDays ?? "—"}</td><td className="px-4 py-3.5"><span className={cn("rounded-full px-2.5 py-1 text-[10px] font-semibold", riskTone[item.risk])}>{riskLabels[item.risk]}</span>{riskReason && <span data-preserve-language className="mt-1 block whitespace-nowrap text-[9px] text-[#8a94a3]">{riskReason}</span>}</td><td data-preserve-language className="max-w-[180px] px-4 py-3.5 text-[#4f6fae]">{item.nextAction}</td><td className="whitespace-nowrap px-4 py-3.5 font-semibold text-[#334155]">{formatMoney(item.amountTotal, item.currency)}</td><td onClick={(event) => event.stopPropagation()} className="px-2 py-3.5"><RouteOrderActionsMenu number={item.number} capabilities={{ followup: data?.permissions?.operate === true, updateRihd: data?.permissions?.approve === true, markAtRisk: data?.permissions?.operate === true }} onViewDetails={() => onOpenOrder(item.id)} onFollowUp={(trigger) => openFollowupDialog(item, trigger)} onEditRihd={(trigger) => openRihdDialog(item, trigger)} onMarkAtRisk={(trigger) => openRiskDialog(item, trigger)} /></td></tr>; })}
            </tbody>
          </table>
        </div>
        {portfolio && !pageItems.length && <div className="flex min-h-[265px] flex-col items-center justify-center border-t border-[#eef1f5] px-6 text-center"><RouteIcon className="size-8 text-[#c2c8d2]" /><div className="mt-3 text-sm font-semibold text-[#596273]">{items.length ? "没有符合当前筛选条件的采购订单" : `尚无已确认的${title}订单`}</div><div className="mt-1 text-[11px] text-[#9299a5]">{items.length ? "请调整阶段、搜索、风险、供应商或日期筛选条件。" : `路线确认队列中仍有 ${unclassified.length} 张活跃采购订单；确认前不会显示在此。`}</div></div>}

        <div className="flex h-14 items-center justify-between border-t border-[#edf0f4] px-5 text-[10px] text-[#7e8795]">{portfolio ? <><span>显示第 {filteredItems.length ? (currentPage - 1) * PAGE_SIZE + 1 : 0} 至 {Math.min(currentPage * PAGE_SIZE, filteredItems.length)} 条，共 {filteredItems.length} 条</span><div className="flex items-center gap-1.5"><button type="button" aria-label="上一页" onClick={() => setCurrentPage((page) => Math.max(1, page - 1))} disabled={currentPage === 1} className="flex size-8 items-center justify-center rounded-lg border border-[#dfe3eb] disabled:opacity-40"><ChevronLeft className="size-3.5" /></button>{pageNumbers.map((page) => <button type="button" key={page} aria-label={String(page)} aria-current={page === currentPage ? "page" : undefined} onClick={() => setCurrentPage(page)} className={cn("flex size-8 items-center justify-center rounded-lg border text-[10px] font-semibold transition", page === currentPage ? "border-[#2563eb] bg-[#2563eb] text-white" : "border-[#dfe3eb] bg-white text-[#697487] hover:border-blue-200 hover:text-blue-700")}>{page}</button>)}<button type="button" aria-label="下一页" onClick={() => setCurrentPage((page) => Math.min(pageCount, page + 1))} disabled={currentPage === pageCount} className="flex size-8 items-center justify-center rounded-lg border border-[#dfe3eb] disabled:opacity-40"><ChevronRight className="size-3.5" /></button></div></> : <span className="h-3 w-44 animate-pulse rounded-full bg-slate-100" />}</div>
      </div>
    </section>
    {unclassified.length > 0 && <section aria-label="待分类采购订单" className="mt-5 overflow-hidden rounded-2xl border border-amber-200 bg-white">
      <div className="border-b border-amber-100 bg-amber-50 px-5 py-3">
        <h2 className="text-sm font-semibold text-amber-950">待分类订单 · {unclassified.length} 张</h2>
        <p className="mt-1 text-xs text-amber-800">以下订单已存在，可直接查看和跟进；确认采购路径后，会进入对应的本地或进口采购列表。</p>
      </div>
      <div className="max-h-64 overflow-y-auto divide-y divide-slate-100">
        {unclassified.map((item) => <div key={item.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
          <button type="button" aria-label={`查看订单 ${item.number}`} onClick={() => onOpenOrder(item.id)} className="min-w-0 flex-1 rounded text-left focus-visible:outline-2 focus-visible:outline-blue-600">
            <span className="block break-all text-xs font-semibold text-blue-700">{item.number}</span>
            <span data-preserve-language className="mt-1 block text-xs text-slate-600">{item.supplierName} · {item.materialType}</span>
          </button>
          <span data-preserve-language={routeStageLabel(item.stage, item.stageLabel) === item.stageLabel ? true : undefined} className="text-xs text-slate-500">{routeStageLabel(item.stage, item.stageLabel)}</span>
          {data?.permissions?.configure && <button type="button" aria-label={`确认路线 ${item.number}`} onClick={(event) => openClassifier(item, event.currentTarget)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-700">确认路线</button>}
        </div>)}
      </div>
    </section>}
    {assistantMode === "closed" && <button type="button" onClick={() => setAssistantMode("normal")} className="fixed bottom-6 right-6 z-30 flex h-11 items-center gap-2 rounded-full bg-gradient-to-r from-[#2563eb] to-[#1746a2] px-4 text-[11px] font-semibold text-white shadow-[0_8px_24px_rgba(37,99,235,0.28)] transition hover:-translate-y-0.5 hover:shadow-[0_10px_28px_rgba(37,99,235,0.36)]"><PanelLeftOpen className="size-4" />Readywork 助理</button>}

    <details className="mt-5 overflow-hidden rounded-2xl border border-[#e2e6ed] bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4"><Sparkles className="size-4 text-blue-600" /><span className="text-xs font-bold text-[#273247]">路线事实与确认队列</span><span className="text-[10px] text-[#8a92a1]">真实运营摘要 · {!portfolio ? "待读取" : unclassified.length ? `${unclassified.length} 张待确认` : "当前无待确认路线"}</span></summary>
      <div className="grid gap-5 border-t border-[#edf0f4] p-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="rounded-2xl bg-[#f7f9fc] p-4">
          <div className="text-xs font-bold text-[#334056]">路线运营摘要</div>
          <p className="mt-2 text-[11px] leading-5 text-[#768092]">这是路线级运营摘要，不是伪造的聊天助手；只汇总 SQLite 中已持久化的 PO、风险、运输、收货和路线证据，不会根据供应商名称猜测路线。</p>
          {portfolio ? <div className="mt-4 grid grid-cols-2 gap-2.5">
            <div className="rounded-xl border border-[#e7ebf1] bg-white px-3 py-3"><div className="text-[22px] font-bold leading-none text-[#172033]">{summary.total}</div><div className="mt-1.5 text-[10px] text-[#8992a0]">活跃 {title} PO</div></div>
            <div className="rounded-xl border border-[#f5d7d7] bg-white px-3 py-3"><div className="text-[22px] font-bold leading-none text-[#dc3f3f]">{summary.high}</div><div className="mt-1.5 text-[10px] text-[#8992a0]">高风险</div></div>
            <div className="rounded-xl border border-[#f0dfb7] bg-white px-3 py-3"><div className="text-[22px] font-bold leading-none text-[#bc7a09]">{unclassified.length}</div><div className="mt-1.5 text-[10px] text-[#8992a0]">路线待确认</div></div>
            <div className="rounded-xl border border-[#d7e5fb] bg-white px-3 py-3"><div className="text-[22px] font-bold leading-none text-[#2563eb]">{evidenceCoverage.eligibleErp}</div><div className="mt-1.5 text-[10px] text-[#8992a0]">ERP 证据可用</div></div>
          </div> : <div className="mt-4 grid grid-cols-2 gap-2.5" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <div key={index} className="rounded-xl border border-[#e7ebf1] bg-white px-3 py-3"><div className="h-6 w-12 animate-pulse rounded-lg bg-slate-100" /><div className="mt-2 h-2.5 w-20 animate-pulse rounded-full bg-slate-100" /></div>)}</div>}
          <div className="mt-3 flex items-center gap-2 border-t border-[#e6eaf0] pt-3"><span className="min-w-0 flex-1 truncate text-[9px] text-[#9199a6]">更新于 {portfolio?.generatedAt ? formatDateTime(portfolio.generatedAt) : "待读取"}</span>{data?.permissions?.configure && <button type="button" onClick={() => void syncOdooRouteSources()} disabled={loading || syncingRouteSources} className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[#dfe3eb] bg-white px-2 text-[9px] font-semibold text-[#596171] disabled:opacity-50"><RefreshCw className={cn("size-3", syncingRouteSources && "animate-spin")} />同步 Odoo</button>}<button type="button" aria-label="刷新采购路线" onClick={() => void load()} disabled={loading || syncingRouteSources} className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-[#dfe3eb] bg-white text-[#6f7888] disabled:opacity-50"><RefreshCw className={cn("size-3", loading && "animate-spin")} /></button></div>
        </div>
        <div>
          <div className="flex items-center justify-between"><div className="text-xs font-bold text-[#334056]">{!portfolio ? "优先事项待读取" : unclassified.length ? "需要确认路线" : "当前优先事项"}</div>{portfolio && <span className="rounded-full bg-[#f1f4f8] px-2 py-1 text-[9px] font-semibold text-[#788394]">{unclassified.length || routePriorities.length} 项</span>}</div>
          <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
            {!portfolio ? Array.from({ length: 2 }, (_, index) => <div key={index} aria-hidden="true" className="rounded-xl border border-[#e5e9ef] bg-white p-3.5"><div className="h-3 w-24 animate-pulse rounded-full bg-slate-100" /><div className="mt-3 h-2.5 w-full animate-pulse rounded-full bg-slate-100" /></div>) : unclassified.length > 0 ? unclassified.slice(0, 6).map((item) => <div key={item.id} className="rounded-xl border border-[#e5e9ef] bg-white p-3.5">
              <div className="flex items-start gap-2.5"><span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600"><AlertTriangle className="size-3.5" /></span><div className="min-w-0 flex-1"><div className="truncate text-xs font-bold text-[#2a3548]">{item.number}</div><div data-preserve-language className="mt-1 truncate text-[10px] text-[#7e8796]">{item.supplierName} · {item.materialType}</div></div></div>
              <div className="mt-3 flex items-center justify-between gap-2"><span className={cn("truncate text-[9px]", item.routeEvidenceCandidates.some((candidate) => candidate.eligible) ? "text-emerald-600" : "text-amber-700")}>{item.routeEvidenceCandidates.some((candidate) => candidate.eligible) ? "存在可核验证据" : "需要补充路线证据"}</span>{data?.permissions?.configure ? <button type="button" onClick={(event) => openClassifier(item, event.currentTarget)} className="shrink-0 rounded-lg bg-[#253a67] px-2.5 py-1.5 text-[9px] font-semibold text-white">确认路线</button> : <span className="shrink-0 text-[9px] text-[#9aa0aa]">经理权限</span>}</div>
            </div>) : routePriorities.length > 0 ? routePriorities.map((item) => <button type="button" key={item.id} onClick={() => onOpenOrder(item.id)} className="flex w-full items-center gap-3 rounded-xl border border-[#e5e9ef] bg-white p-3.5 text-left hover:border-blue-200 hover:bg-blue-50/30"><span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", item.risk === "high" ? "bg-red-50 text-red-500" : item.risk === "medium" ? "bg-amber-50 text-amber-600" : "bg-emerald-50 text-emerald-600")}><ShieldAlert className="size-3.5" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-bold text-[#2a3548]">{item.number}</span><span className="mt-1 block truncate text-[10px] text-[#7e8796]">{item.nextAction}</span></span><ArrowRight className="size-3.5 text-[#a0a8b4]" /></button>) : <div className="rounded-xl border border-dashed border-[#dfe4eb] px-4 py-7 text-center"><CheckCircle2 className="mx-auto size-6 text-emerald-500" /><div className="mt-2 text-xs font-semibold text-[#596476]">当前没有已确认的 {title} PO</div><div className="mt-1 text-[10px] text-[#969eaa]">未分类真实订单仍保留在路线确认队列中。</div></div>}
          </div>
        </div>
      </div>
    </details>

    {data?.permissions?.configure && documentManagedItems.length > 0 && <details className="mt-5 overflow-hidden rounded-2xl border border-[#e2e6ed] bg-white"><summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4"><FileCheck2 className="size-4 text-blue-600" /><span className="text-xs font-bold text-[#273247]">路线证据治理</span><span className="text-[10px] text-[#8a92a1]">{documentManagedItems.length} 张 PO 使用受控文件证据</span></summary><div className="divide-y divide-[#eef1f5] border-t border-[#edf0f4]">{documentManagedItems.slice(0, 10).map((item) => <div key={item.id} className="flex items-center gap-3 px-5 py-3"><div className="min-w-0 flex-1"><div className="text-xs font-bold text-[#273247]">{item.number}</div><div data-preserve-language className="mt-1 truncate text-[10px] text-[#7c8594]">{item.supplierName} · {item.routeEvidenceCandidates.filter((candidate) => candidate.type === "route_document").length} 份有效文件证据</div></div><button type="button" onClick={(event) => openClassifier(item, event.currentTarget)} className="flex h-8 items-center gap-2 rounded-lg border border-[#dfe3ea] px-3 text-[10px] font-semibold text-[#4f6fae]">管理证据 <ArrowRight className="size-3" /></button></div>)}</div></details>}

    {followupTarget && <RouteWorkbenchDialog className="max-w-[620px]" isLocked={() => followupInFlightRef.current} onClose={closeFollowupDialog} returnFocusRef={followupReturnFocusRef} titleId="followup-dialog-title">
        <div className="flex items-start justify-between gap-4"><div><div className="flex size-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Mail className="size-5" /></div><Dialog.Title id="followup-dialog-title" className="mt-4 text-xl font-bold text-[#192236]">发送跟进</Dialog.Title><p data-preserve-language className="mt-1 text-xs text-[#7a8393]">{followupTarget.number} · {followupTarget.supplierName}</p></div><button type="button" aria-label="关闭" onClick={closeFollowupDialog} disabled={followupSubmitting} className="flex size-9 items-center justify-center rounded-xl bg-[#f3f5f8] text-[#7d8490] disabled:opacity-50"><X className="size-4" /></button></div>
        {followupError && <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" />{followupError}</div>}
        {followupResult ? <div className="mt-6">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" /><div><div className="text-sm font-bold text-emerald-800">跟进草稿已持久化</div><div className="mt-1 text-xs leading-5 text-emerald-700">{followupResult.subject}</div><div className="mt-2 font-mono text-[10px] text-emerald-700">草稿 v{followupResult.version} · 已保存</div></div></div></div>
          <p className="mt-4 text-xs leading-5 text-[#687386]">邮件尚未发送。请在草稿邮件中核对收件人、主题和正文，再批准进入真实发件箱。</p>
          <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={closeFollowupDialog} className="h-10 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#626b7a]">关闭</button>{onOpenMessageDrafts && <button type="button" onClick={() => onOpenMessageDrafts(followupResult.id)} className="h-10 rounded-xl bg-[#2563eb] px-5 text-xs font-semibold text-white">前往草稿邮件</button>}</div>
        </div> : <>
          <div className="mt-6 grid grid-cols-3 gap-3 rounded-2xl border border-[#e6eaf0] bg-[#f8fafc] p-4 text-[10px]"><div><div className="text-[#929aaa]">当前阶段</div><div className="mt-1 font-semibold text-[#334056]">{routeStageLabel(followupTarget.stage, followupTarget.stageLabel)}</div></div><div><div className="text-[#929aaa]">风险</div><div className="mt-1 font-semibold text-[#334056]">{riskLabels[followupTarget.risk]}</div></div><div><div className="text-[#929aaa]">RIHD</div><div className="mt-1 font-semibold text-[#334056]">{formatDate(followupTarget.requiredInHouseAt)}</div></div></div>
          {!data?.permissions?.operate ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">当前角色只能查看，没有生成跟进草稿的操作权限。</div> : !followupTarget.actionReadiness.queue_followup.ready ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">{followupTarget.actionReadiness.queue_followup.message}</div> : <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-700">本操作只生成可审核邮件草稿，不会立即发送。</div>}
          <label className="mt-5 block"><span className="text-xs font-semibold text-[#5f6878]">跟进要求 <span className="text-red-500">*</span></span><textarea value={followupReason} onChange={(event) => setFollowupReason(event.target.value)} disabled={followupSubmitting || !data?.permissions?.operate || !followupTarget.actionReadiness.queue_followup.ready} className="mt-2 min-h-[116px] w-full resize-none rounded-2xl border border-[#dfe3ea] px-4 py-3 text-sm leading-6 outline-none focus:border-[#2563eb] disabled:bg-[#f5f6f8] disabled:text-[#9299a5]" /></label>
          <div className="mt-4 rounded-2xl bg-[#f7f9fc] p-4"><div className="text-[11px] font-bold text-[#435066]">确认后将执行</div><ul className="mt-2 space-y-1.5 text-[10px] leading-4 text-[#738094]"><li>· 校验 PO 版本、供应商真实邮箱和具名采购身份</li><li>· 在 SQLite 中创建带业务证据的版本化草稿和审计事件</li><li>· 不发邮件、不写 Odoo、不推进 PO 阶段</li></ul></div>
          <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={closeFollowupDialog} disabled={followupSubmitting} className="h-10 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#626b7a] disabled:opacity-50">取消</button><button type="button" onClick={() => void createFollowupDraft()} disabled={followupSubmitting || !data?.permissions?.operate || !followupTarget.actionReadiness.queue_followup.ready || followupReason.trim().length < 4} className="flex h-10 items-center gap-2 rounded-xl bg-[#2563eb] px-5 text-xs font-semibold text-white shadow-lg shadow-blue-100 disabled:opacity-50">{followupSubmitting ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}生成跟进草稿</button></div>
        </>}
    </RouteWorkbenchDialog>}

    {rihdTarget && <RouteWorkbenchDialog className="max-w-[620px]" isLocked={() => rihdInFlightRef.current || rihdPollingInFlightRef.current} onClose={closeRihdDialog} returnFocusRef={rihdReturnFocusRef} titleId="rihd-dialog-title">
        <div className="flex items-start justify-between gap-4"><div><div className="flex size-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><CalendarDays className="size-5" /></div><Dialog.Title id="rihd-dialog-title" className="mt-4 text-xl font-bold text-[#192236]">修改 RIHD</Dialog.Title><p data-preserve-language className="mt-1 text-xs text-[#7a8393]">{rihdTarget.number} · {rihdTarget.supplierName}</p></div><button type="button" aria-label="关闭" onClick={closeRihdDialog} disabled={rihdSubmitting} className="flex size-9 items-center justify-center rounded-xl bg-[#f3f5f8] text-[#7d8490] disabled:opacity-50"><X className="size-4" /></button></div>
        <div className="mt-6 grid grid-cols-3 gap-3 rounded-2xl border border-[#e6eaf0] bg-[#f8fafc] p-4 text-[10px]"><div><div className="text-[#929aaa]">当前阶段</div><div className="mt-1 font-semibold text-[#334056]">{routeStageLabel(rihdTarget.stage, rihdTarget.stageLabel)}</div></div><div><div className="text-[#929aaa]">风险</div><div className="mt-1 font-semibold text-[#334056]">{riskLabels[rihdTarget.risk]}</div></div><div><div className="text-[#929aaa]">当前 RIHD</div><div className="mt-1 font-semibold text-[#334056]">{formatDate(rihdTarget.requiredInHouseAt)}</div></div></div>
        {rihdError && <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" />{rihdError}</div>}
        {rihdOutbox ? <div className="mt-5">
          <div className={cn("rounded-2xl border p-4", rihdOutbox.status === "dispatched" && rihdReadbackVerified ? "border-emerald-200 bg-emerald-50" : rihdOutbox.status === "failed" ? "border-red-200 bg-red-50" : rihdOutbox.status === "blocked" || rihdOutbox.status === "dispatched" ? "border-amber-200 bg-amber-50" : "border-blue-200 bg-blue-50")}>
            <div className="flex items-start gap-3">{rihdOutbox.status === "dispatched" && rihdReadbackVerified ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" /> : rihdOutbox.status === "failed" ? <AlertCircle className="mt-0.5 size-5 shrink-0 text-red-600" /> : rihdOutbox.status === "blocked" || rihdOutbox.status === "dispatched" ? <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" /> : <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-blue-600" />}<div><div className="text-sm font-bold text-[#263348]">{rihdOutbox.status === "dispatched" && rihdReadbackVerified ? "Odoo 写入与回读核验已完成" : rihdOutbox.status === "dispatched" ? "Odoo 已提交，等待权威 RIHD 回读核验" : rihdOutbox.status === "failed" ? "Odoo 回写未能确认" : rihdOutbox.status === "blocked" ? "等待 Odoo 连接器就绪" : "正在等待 Odoo 真实回执"}</div><div className="mt-1 text-xs leading-5 text-[#637086]">{rihdOutbox.status === "dispatched" && rihdReadbackVerified ? `RIHD 已生效为 ${rihdDate}，SQLite、PO 行、数字孪生与审计已同步。` : rihdOutbox.status === "dispatched" ? "回读尚未确认；页面继续显示上次已确认 RIHD，不会提前显示成功。" : rihdOutbox.status === "failed" ? (rihdOutbox.error ?? "请核对 Odoo 实际值后再决定是否重试。") : rihdOutbox.status === "blocked" ? "当前未改动 SQLite RIHD；连接器就绪后由 ERP 发件箱继续执行。" : "只有 Odoo 所有订单行 date_planned 回读一致后，本地 RIHD 才会生效。"}</div><div className="mt-2 font-mono text-[9px] text-[#798497]">{rihdOutbox.id} · {rihdOutbox.status === "dispatched" && !rihdReadbackVerified ? "已提交，待回读" : { blocked: "已阻止", pending: "待处理", processing: "处理中", dispatched: "已提交", failed: "失败" }[rihdOutbox.status]}</div></div></div>
          </div>
          <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={closeRihdDialog} disabled={rihdSubmitting || rihdPolling} className="h-10 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#626b7a] disabled:opacity-50">关闭</button>{rihdOutbox.status !== "failed" && !(rihdOutbox.status === "dispatched" && rihdReadbackVerified) && <button type="button" onClick={() => void refreshRihdOutbox(rihdOutbox.id)} disabled={rihdPolling || rihdSubmitting} className="flex h-10 items-center gap-2 rounded-xl bg-[#2563eb] px-5 text-xs font-semibold text-white disabled:opacity-50">{rihdPolling ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}{rihdOutbox.status === "dispatched" ? "重新核验 RIHD" : "刷新回执"}</button>}</div>
        </div> : <>
          {!data?.permissions?.approve ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">当前角色没有修改 RIHD 所需的审批权限。</div> : !rihdTarget.actionReadiness.update_rihd.ready ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">{rihdTarget.actionReadiness.update_rihd.message}</div> : <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-700">修改将先进入 ERP 发件箱；页面不会在 Odoo 回执前显示成功。</div>}
          <div className="mt-5 grid gap-4 sm:grid-cols-2"><label><span className="text-xs font-semibold text-[#5f6878]">新 RIHD <span className="text-red-500">*</span></span><input type="date" value={rihdDate} onChange={(event) => setRihdDate(event.target.value)} disabled={rihdSubmitting || !data?.permissions?.approve || !rihdTarget.actionReadiness.update_rihd.ready} className="mt-2 h-11 w-full rounded-xl border border-[#dfe3ea] bg-white px-3 text-sm text-[#334056] outline-none focus:border-[#2563eb] disabled:bg-[#f5f6f8]" /></label><div className="rounded-xl border border-[#e5e9ef] bg-[#fafbfc] px-4 py-3"><div className="text-[10px] text-[#929aaa]">Odoo 写入字段</div><div className="mt-1 text-xs font-semibold text-[#334056]">purchase.order.line.date_planned</div><div className="mt-1 text-[9px] leading-4 text-[#8a92a1]">将核验当前 PO 的全部行</div></div></div>
          <label className="mt-4 block"><span className="text-xs font-semibold text-[#5f6878]">修改原因 <span className="text-red-500">*</span></span><textarea value={rihdReason} onChange={(event) => setRihdReason(event.target.value)} disabled={rihdSubmitting || !data?.permissions?.approve || !rihdTarget.actionReadiness.update_rihd.ready} placeholder="例如：内部需求日调整，已与项目负责人确认" className="mt-2 min-h-[100px] w-full resize-none rounded-2xl border border-[#dfe3ea] px-4 py-3 text-sm leading-6 outline-none focus:border-[#2563eb] disabled:bg-[#f5f6f8]" /></label>
          <div className="mt-4 rounded-2xl bg-[#f7f9fc] p-4"><div className="text-[11px] font-bold text-[#435066]">确认后将执行</div><ul className="mt-2 space-y-1.5 text-[10px] leading-4 text-[#738094]"><li>· 冻结 PO 版本、原/新 RIHD、Odoo 单号、订单行与原因</li><li>· 在 Odoo 写入全部行的 date_planned，随后重新读取核验</li><li>· 核验成功后才更新 SQLite、数字孪生、风险/SLA 读模型和审计活动</li></ul></div>
          <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={closeRihdDialog} disabled={rihdSubmitting} className="h-10 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#626b7a] disabled:opacity-50">取消</button><button type="button" onClick={() => void submitRihdUpdate()} disabled={rihdSubmitting || !data?.permissions?.approve || !rihdTarget.actionReadiness.update_rihd.ready || !rihdDate || rihdDate === rihdTarget.requiredInHouseAt?.slice(0, 10) || rihdReason.trim().length < 4} className="flex h-10 items-center gap-2 rounded-xl bg-[#2563eb] px-5 text-xs font-semibold text-white shadow-lg shadow-blue-100 disabled:opacity-50">{rihdSubmitting ? <Loader2 className="size-4 animate-spin" /> : <CalendarDays className="size-4" />}提交并等待 Odoo 回执</button></div>
        </>}
    </RouteWorkbenchDialog>}

    {riskTarget && <RouteWorkbenchDialog className="max-w-[620px]" isLocked={() => riskInFlightRef.current} onClose={closeRiskDialog} returnFocusRef={riskReturnFocusRef} titleId="risk-dialog-title">
        <div className="flex items-start justify-between gap-4"><div><div className="flex size-10 items-center justify-center rounded-xl bg-red-50 text-red-600"><ShieldAlert className="size-5" /></div><Dialog.Title id="risk-dialog-title" className="mt-4 text-xl font-bold text-[#192236]">标记风险</Dialog.Title><p data-preserve-language className="mt-1 text-xs text-[#7a8393]">{riskTarget.number} · {riskTarget.supplierName}</p></div><button type="button" aria-label="关闭" onClick={closeRiskDialog} disabled={manualRiskSubmitting} className="flex size-9 items-center justify-center rounded-xl bg-[#f3f5f8] text-[#7d8490] disabled:opacity-50"><X className="size-4" /></button></div>
        <div className="mt-6 grid grid-cols-3 gap-3 rounded-2xl border border-[#e6eaf0] bg-[#f8fafc] p-4 text-[10px]"><div><div className="text-[#929aaa]">当前阶段</div><div className="mt-1 font-semibold text-[#334056]">{routeStageLabel(riskTarget.stage, riskTarget.stageLabel)}</div></div><div><div className="text-[#929aaa]">当前风险</div><div className="mt-1 font-semibold text-[#334056]">{riskLabels[riskTarget.risk]}</div></div><div><div className="text-[#929aaa]">RIHD</div><div className="mt-1 font-semibold text-[#334056]">{formatDate(riskTarget.requiredInHouseAt)}</div></div></div>
        {manualRiskError && <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" />{manualRiskError}</div>}
        {manualRiskResult ? <div className="mt-5">
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4"><div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 size-5 shrink-0 text-red-600" /><div><div className="text-sm font-bold text-red-800">风险事实已持久化</div><div className="mt-1 text-xs leading-5 text-red-700">{manualRiskLabels[manualRiskResult.severity]}已进入统一异常中心，并立即参与当前 PO 的风险计算。</div><div className="mt-2 font-mono text-[9px] text-red-700">{manualRiskResult.id} · 已分配</div></div></div></div>
          <p className="mt-4 text-xs leading-5 text-[#687386]">该动作没有发送邮件、写入 Odoo 或推进 PO 阶段。后续处置与关闭必须保留在异常审计链中。</p>
          <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={closeRiskDialog} className="h-10 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#626b7a]">关闭</button><button type="button" onClick={() => { const id = riskTarget.id; closeRiskDialog(); onOpenOrder(id); }} className="h-10 rounded-xl bg-[#253a67] px-5 text-xs font-semibold text-white">查看 PO 上下文</button></div>
        </div> : <>
          {!data?.permissions?.operate ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">当前角色只能查看，没有创建人工风险事实的操作权限。</div> : !riskTarget.actionReadiness.mark_at_risk.ready ? <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">{riskTarget.actionReadiness.mark_at_risk.message}{riskTarget.actionReadiness.mark_at_risk.exceptionId ? <span className="mt-1 block font-mono text-[9px]">{riskTarget.actionReadiness.mark_at_risk.exceptionId}</span> : null}</div> : <div className="mt-4 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700">这是一条人工风险判断，将进入统一异常中心和审计时间线。</div>}
          <div className="mt-5 grid gap-4 sm:grid-cols-2"><label><span className="text-xs font-semibold text-[#5f6878]">风险级别 <span className="text-red-500">*</span></span><select value={manualRiskSeverity} onChange={(event) => setManualRiskSeverity(event.target.value as ManualRiskSeverity)} disabled={manualRiskSubmitting || !data?.permissions?.operate || !riskTarget.actionReadiness.mark_at_risk.ready} className="mt-2 h-11 w-full rounded-xl border border-[#dfe3ea] bg-white px-3 text-sm text-[#334056] outline-none focus:border-red-400 disabled:bg-[#f5f6f8]"><option value="medium">中风险</option><option value="high">高风险</option><option value="critical">严重风险</option></select></label><label><span className="text-xs font-semibold text-[#5f6878]">风险类别 <span className="text-red-500">*</span></span><select value={manualRiskCategory} onChange={(event) => setManualRiskCategory(event.target.value as ManualRiskCategory)} disabled={manualRiskSubmitting || !data?.permissions?.operate || !riskTarget.actionReadiness.mark_at_risk.ready} className="mt-2 h-11 w-full rounded-xl border border-[#dfe3ea] bg-white px-3 text-sm text-[#334056] outline-none focus:border-red-400 disabled:bg-[#f5f6f8]">{(Object.entries(manualRiskCategoryLabels) as Array<[ManualRiskCategory, string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <label className="mt-4 block"><span className="text-xs font-semibold text-[#5f6878]">风险原因 <span className="text-red-500">*</span></span><textarea value={manualRiskReason} onChange={(event) => setManualRiskReason(event.target.value)} disabled={manualRiskSubmitting || !data?.permissions?.operate || !riskTarget.actionReadiness.mark_at_risk.ready} placeholder="说明可核验的风险事实，例如：供应商反馈关键物料短缺，预计影响原承诺交期" className="mt-2 min-h-[100px] w-full resize-none rounded-2xl border border-[#dfe3ea] px-4 py-3 text-sm leading-6 outline-none focus:border-red-400 disabled:bg-[#f5f6f8]" /></label>
          <label className="mt-4 block"><span className="text-xs font-semibold text-[#5f6878]">建议处置</span><textarea value={manualRiskRecommendation} onChange={(event) => setManualRiskRecommendation(event.target.value)} disabled={manualRiskSubmitting || !data?.permissions?.operate || !riskTarget.actionReadiness.mark_at_risk.ready} placeholder="可选；例如：要求供应商在 24 小时内提供恢复计划并升级采购经理" className="mt-2 min-h-[84px] w-full resize-none rounded-2xl border border-[#dfe3ea] px-4 py-3 text-sm leading-6 outline-none focus:border-red-400 disabled:bg-[#f5f6f8]" /></label>
          <div className="mt-4 rounded-2xl bg-[#f7f9fc] p-4"><div className="text-[11px] font-bold text-[#435066]">确认后将执行</div><ul className="mt-2 space-y-1.5 text-[10px] leading-4 text-[#738094]"><li>· 校验当前租户、PO 版本、状态、操作权限和幂等键</li><li>· 单事务写入人工风险事实、统一异常与活动审计</li><li>· 刷新概览、路线页、风险仪表盘和 PO 上下文的真实风险</li><li>· 不发送邮件、不写 Odoo、不改变 PO 执行阶段</li></ul></div>
          <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={closeRiskDialog} disabled={manualRiskSubmitting} className="h-10 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#626b7a] disabled:opacity-50">取消</button><button type="button" onClick={() => void submitManualRisk()} disabled={manualRiskSubmitting || !data?.permissions?.operate || !riskTarget.actionReadiness.mark_at_risk.ready || manualRiskReason.trim().length < 4 || (manualRiskRecommendation.trim().length > 0 && manualRiskRecommendation.trim().length < 4)} className="flex h-10 items-center gap-2 rounded-xl bg-red-600 px-5 text-xs font-semibold text-white shadow-lg shadow-red-100 disabled:opacity-50">{manualRiskSubmitting ? <Loader2 className="size-4 animate-spin" /> : <ShieldAlert className="size-4" />}标记为风险</button></div>
        </>}
    </RouteWorkbenchDialog>}

    {selected && <RouteWorkbenchDialog className="max-w-[680px] max-h-[calc(100dvh-32px)]" isLocked={() => assignmentInFlightRef.current || uploadEvidenceInFlightRef.current || bindEvidenceInFlightRef.current || revokeEvidenceInFlightRef.current} onClose={closeClassifier} returnFocusRef={routeReturnFocusRef} titleId="route-dialog-title">
        <div className="flex items-start justify-between gap-4"><div><Dialog.Title id="route-dialog-title" className="text-xl font-bold text-[#192236]">确认采购路线</Dialog.Title><p data-preserve-language className="mt-1 text-xs text-[#7a8393]">{selected.number} · {selected.supplierName}</p></div><button type="button" aria-label="关闭" onClick={closeClassifier} disabled={saving || uploadingEvidence || bindingEvidence || revokingEvidenceId !== null} className="flex size-9 items-center justify-center rounded-xl bg-[#f3f5f8] text-[#7d8490] disabled:opacity-50"><X className="size-4" /></button></div>
        {routeDialogError && <div role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" />{routeDialogError}</div>}
        <div className="mt-6 grid grid-cols-2 gap-3">{([['local', '本地采购', ShoppingCart], ['import', '进口采购', Globe2]] as const).map(([value, label, Icon]) => <button key={value} type="button" onClick={() => setTargetRoute(value)} className={cn("flex h-20 flex-col items-center justify-center gap-2 rounded-2xl border text-sm font-semibold transition", targetRoute === value ? "border-[#2563eb] bg-[#eef4ff] text-[#2563eb]" : "border-[#e1e5ec] text-[#667084]")}><Icon className="size-5" />{label}</button>)}</div>
        <p className="mt-2 text-[10px] leading-4 text-[#8a92a1]">路线由采购经理选择；PO Incoterm 与供应商地址只作为可追溯 ERP 证据，系统不自动猜测本地或进口。</p>
        <label className="mt-5 block"><span className="text-xs font-semibold text-[#5f6878]">证据类型</span><select value={evidenceType} onChange={(event) => changeEvidenceType(event.target.value as RouteEvidenceType)} className="mt-2 h-10 w-full rounded-xl border border-[#dfe3ea] bg-white px-3 text-sm outline-none focus:border-[#2563eb]"><option value="contract">合同</option><option value="incoterm">Incoterm</option><option value="erp_field">ERP 字段</option><option value="manual_review">人工复核</option></select></label>
        {evidenceType === "erp_field" ? <div className="mt-4">
          <div className="text-xs font-semibold text-[#5f6878]">实际 ERP 证据 <span className="text-red-500">*</span></div>
          {evidenceCandidates.length ? <div className="mt-2 space-y-2">{evidenceCandidates.map((candidate) => <label key={candidate.id} className={cn("flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition", evidenceReference === candidate.reference ? "border-blue-300 bg-blue-50/70" : "border-[#dfe3ea] hover:border-blue-200")}><input type="radio" name="route-evidence-candidate" value={candidate.reference} checked={evidenceReference === candidate.reference} onChange={() => setEvidenceReference(candidate.reference)} className="mt-1" /><span className="min-w-0"><span className="block text-sm font-semibold text-[#25324a]">{candidate.label}</span><span className="mt-1 block text-xs leading-5 text-[#596579]">{candidate.summary}</span><span className="mt-2 block font-mono text-[9px] text-[#8b95a5]">{candidate.supplierVersion ? `供应商 v${candidate.supplierVersion} · ` : ""}PO v{candidate.purchaseOrderVersion} · {candidate.sourceSystem}</span></span></label>)}</div> : <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs leading-5 text-amber-800">当前 PO 没有可用的 Incoterm，供应商主数据也没有国家或地址。请先在 Odoo 补齐并同步，或改用合同文件 / 人工复核证据。</div>}
        </div> : evidenceType === "contract" || evidenceType === "incoterm" ? <div className="mt-4 space-y-4">
          {routeEvidenceLoading && <div className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-3 text-xs text-blue-700"><Loader2 className="size-4 animate-spin" />正在读取当前 PO 的真实附件与证据链…</div>}
          <div><div className="text-xs font-semibold text-[#5f6878]">已持久化证据文件 <span className="text-red-500">*</span></div>
            {evidenceCandidates.length ? <div className="mt-2 space-y-2">{evidenceCandidates.map((candidate) => { const status = documentCandidateStatus(candidate); return <label key={candidate.id} className={cn("flex items-start gap-3 rounded-2xl border p-4 transition", candidate.eligible ? "cursor-pointer hover:border-blue-200" : "cursor-not-allowed opacity-75", evidenceReference === candidate.reference ? "border-blue-300 bg-blue-50/70" : "border-[#dfe3ea]")}><input type="radio" name="route-document-candidate" disabled={!candidate.eligible} checked={evidenceReference === candidate.reference} onChange={() => setEvidenceReference(candidate.reference)} className="mt-1" /><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold text-[#25324a]">{candidate.fields.businessReference ?? candidate.label}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", status.tone)}>{status.label}</span></span><span className="mt-1 block truncate text-xs text-[#596579]">{candidate.fields.fileName ?? candidate.summary}</span><span className="mt-2 block font-mono text-[9px] text-[#8b95a5]">附件 v{candidate.fields.attachmentVersion ?? "?"} · PO v{candidate.purchaseOrderVersion} · {candidate.fields.sha256?.slice(0, 12) ?? "SHA 待核验"}</span></span></label>; })}</div> : <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-xs leading-5 text-slate-600">尚未上传{evidenceType === "contract" ? "合同" : "Incoterm"}文件。自由文本编号不能作为路线证据。</div>}
            {activeEvidenceDocuments.length > 0 && <div className="mt-3 space-y-2 border-t border-[#edf0f4] pt-3"><div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#9299a5]">已绑定文件治理</div>{activeEvidenceDocuments.map((document) => <div key={document.id} className="flex items-center gap-2 rounded-xl bg-[#f7f8fa] px-3 py-2"><FileCheck2 className="size-4 shrink-0 text-emerald-600" /><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-[#394459]">{document.businessReference}</div><div className="mt-0.5 truncate font-mono text-[9px] text-[#8b95a5]">{document.fileName} · 证据 v{document.version} · 附件 v{document.attachmentVersion}</div></div>{document.contentUrl && <button type="button" onClick={() => window.open(document.contentUrl, "_blank", "noopener,noreferrer")} className="flex size-8 items-center justify-center rounded-lg text-[#657083] hover:bg-white" aria-label={`打开 ${document.fileName}`}><ExternalLink className="size-3.5" /></button>}{routeEvidenceData?.permissions.configure && <button type="button" onClick={() => void revokeRouteEvidence(document)} disabled={revokingEvidenceId !== null || saving || bindingEvidence || uploadingEvidence} className="flex h-8 items-center gap-1 rounded-lg border border-red-100 bg-white px-2 text-[10px] font-semibold text-red-600 disabled:opacity-50">{revokingEvidenceId === document.id ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}撤销</button>}</div>)}</div>}
          </div>
          <div className="rounded-2xl border border-[#dfe5ef] bg-[#f8fafc] p-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#4f5b6f]"><Link2 className="size-4 text-blue-600" />复用当前 PO 已有附件</div>
            <p className="mt-1.5 text-[10px] leading-4 text-[#8a92a1]">只能绑定归属于当前 PO、ClamAV 为 clean 且已解析的活跃版本。</p>
            {routeEvidenceData?.availableAttachments.length ? <><select aria-label="现有 PO 附件" value={selectedExistingAttachmentId} onChange={(event) => setSelectedExistingAttachmentId(event.target.value)} className="mt-3 h-10 w-full rounded-xl border border-[#dfe3ea] bg-white px-3 text-xs text-[#596579] outline-none focus:border-blue-400"><option value="">选择现有附件</option>{routeEvidenceData.availableAttachments.map((attachment) => <option key={attachment.id} value={attachment.id} disabled={!attachment.eligible}>{attachment.fileName} · v{attachment.version}{attachment.eligible ? " · 可用" : ` · ${attachment.securityStatus}/${attachment.processingStatus}`}</option>)}</select>
              {selectedExistingAttachment && <div className="mt-2 rounded-xl border border-[#e4e8ef] bg-white px-3 py-2"><div className="flex items-center gap-2"><FileCheck2 className={cn("size-4 shrink-0", selectedExistingAttachment.eligible ? "text-emerald-600" : "text-amber-600")} /><div className="min-w-0 flex-1"><div className="truncate text-xs font-semibold text-[#394459]">{selectedExistingAttachment.fileName}</div><div className="mt-0.5 font-mono text-[9px] text-[#8b95a5]">v{selectedExistingAttachment.version} · {Math.max(1, Math.round(selectedExistingAttachment.sizeBytes / 1024))} KB · {selectedExistingAttachment.sha256.slice(0, 12)}</div></div>{selectedExistingAttachment.contentUrl && <button type="button" onClick={() => window.open(selectedExistingAttachment.contentUrl, "_blank", "noopener,noreferrer")} className="flex h-8 items-center gap-1 rounded-lg border border-[#e1e5ec] px-2 text-[10px] font-semibold text-[#596579]"><ExternalLink className="size-3" />打开</button>}</div>{selectedExistingAttachment.extractedTextPreview && <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-[#7b8493]">{selectedExistingAttachment.extractedTextPreview}</p>}</div>}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row"><input value={existingBusinessReference} onChange={(event) => setExistingBusinessReference(event.target.value)} placeholder={evidenceType === "contract" ? "填写合同号" : "填写贸易条款编号"} className="h-10 min-w-0 flex-1 rounded-xl border border-[#dfe3ea] bg-white px-3 text-xs outline-none focus:border-blue-400" /><button type="button" onClick={() => void bindExistingRouteEvidence()} disabled={bindingEvidence || routeEvidenceLoading || !selectedExistingAttachment?.eligible || !existingBusinessReference.trim()} className="flex h-10 items-center justify-center gap-2 rounded-xl bg-[#253a67] px-4 text-xs font-semibold text-white disabled:opacity-50">{bindingEvidence ? <Loader2 className="size-3.5 animate-spin" /> : <Link2 className="size-3.5" />}绑定为证据</button></div></> : !routeEvidenceLoading && <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-3 text-xs leading-5 text-slate-600">当前 PO 没有可复用的未绑定附件。</div>}
          </div>
          <div className="rounded-2xl border border-dashed border-[#cfd7e4] bg-[#fafbfd] p-4"><div className="flex items-center gap-2 text-xs font-semibold text-[#4f5b6f]"><FileUp className="size-4 text-blue-600" />上传新证据版本</div><div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><label className="text-[11px] font-semibold text-[#687386]">业务引用<input value={evidenceBusinessReference} onChange={(event) => setEvidenceBusinessReference(event.target.value)} placeholder={evidenceType === "contract" ? "合同号" : "贸易条款编号"} className="mt-1.5 h-10 w-full rounded-xl border border-[#dfe3ea] bg-white px-3 text-xs font-normal outline-none focus:border-blue-400" /></label><label className="text-[11px] font-semibold text-[#687386]">原始文件<span className="mt-1.5 flex h-10 cursor-pointer items-center rounded-xl border border-[#dfe3ea] bg-white px-3 text-xs font-normal text-[#667084]"><input type="file" className="sr-only" accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.docx,.xlsx" onChange={(event) => setEvidenceFile(event.target.files?.[0] ?? null)} /><span className="truncate">{evidenceFile?.name ?? "选择文件（最大 8 MB）"}</span></span></label></div><button type="button" onClick={() => void uploadRouteEvidence()} disabled={uploadingEvidence || bindingEvidence || revokingEvidenceId !== null || !evidenceFile || !evidenceBusinessReference.trim()} className="mt-3 flex h-9 items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 text-xs font-semibold text-blue-700 disabled:opacity-50">{uploadingEvidence ? <Loader2 className="size-3.5 animate-spin" /> : <FileUp className="size-3.5" />}上传并进入扫描</button><p className="mt-2 text-[10px] leading-4 text-[#8a92a1]">上传成功只表示已持久化；ClamAV 明确为 clean 且解析完成后，才可选择并确认路线。</p></div>
        </div> : <label className="mt-4 block"><span className="text-xs font-semibold text-[#5f6878]">人工核验记录 <span className="text-red-500">*</span></span><input value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} placeholder="核验记录号 / 审批记录号" className="mt-2 h-10 w-full rounded-xl border border-[#dfe3ea] px-3 text-sm outline-none focus:border-[#2563eb]" /></label>}
        <label className="mt-4 block"><span className="text-xs font-semibold text-[#5f6878]">判断说明</span><textarea value={evidenceNotes} onChange={(event) => setEvidenceNotes(event.target.value)} placeholder="说明为何依据该证据确认为本地或进口（可选）" className="mt-2 min-h-[92px] w-full resize-none rounded-2xl border border-[#dfe3ea] px-4 py-3 text-sm leading-6 outline-none focus:border-[#2563eb]" /></label>
        {selectedEvidenceCandidate && <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] leading-5 text-slate-500">保存时将冻结{selectedEvidenceCandidate.type === "route_document" ? `文件、附件版本 ${selectedEvidenceCandidate.fields.attachmentVersion ?? "?"}、SHA-256、` : selectedEvidenceCandidate.supplierVersion ? `供应商版本 ${selectedEvidenceCandidate.supplierVersion}、` : ""}PO 版本 {selectedEvidenceCandidate.purchaseOrderVersion} 及完整来源字段；版本或安全状态变化后必须刷新重选。</div>}
        <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={closeClassifier} disabled={saving || uploadingEvidence || bindingEvidence || revokingEvidenceId !== null} className="h-10 rounded-xl border border-[#dfe3ea] px-4 text-xs font-semibold text-[#626b7a] disabled:opacity-50">取消</button><button type="button" onClick={() => void assignRoute()} disabled={saving || uploadingEvidence || bindingEvidence || revokingEvidenceId !== null || routeEvidenceLoading || !evidenceReference.trim() || (evidenceType !== "manual_review" && (!selectedEvidenceCandidate || !selectedEvidenceCandidate.eligible || selectedEvidenceCandidate.evidenceType !== evidenceType))} className="flex h-10 items-center gap-2 rounded-xl bg-[#2563eb] px-5 text-xs font-semibold text-white shadow-lg shadow-blue-100 disabled:opacity-50">{saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}保存并记录审计</button></div>
    </RouteWorkbenchDialog>}
  </div>;
}
