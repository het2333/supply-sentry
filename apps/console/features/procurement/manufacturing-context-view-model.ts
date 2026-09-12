export type ContextRecord = Record<string, unknown>;
export type LabeledContextRecord = ContextRecord & { typeLabel: string };
export type LabeledRelation = ContextRecord & { typeLabel: string; fromLabel: string; toLabel: string };
export type LabeledEvidence = ContextRecord & { sourceLabel: string; entityLabel: string };

export type ManufacturingContextEnvelope = {
  data: ContextRecord;
  sourceWatermark: string;
  projectionStatus: "current" | "lagging" | "degraded" | "unavailable";
  missingFacts: string[];
  conflicts: Array<{ factPath: string; selectedEvidenceId: string; conflictingEvidenceIds: string[] }>;
  truncated: boolean;
  nextCursor: string | null;
};

const entityLabels: Record<string, string> = {
  supplier: "供应商", contact: "联系人", material: "物料", requisition: "采购申请", rfq: "询价单", quote: "报价单", award: "定标", purchase_order: "采购订单", po_line: "采购订单行", communication: "沟通记录", shipment: "发运 / ASN", receipt: "收货 / GRN", invoice: "供应商发票", sla_evaluation: "SLA 评估",
};

const relationLabels: Record<string, string> = {
  ordered_from: "向供应商下单", contains_line: "包含订单行", for_material: "对应物料", created_from_award: "由定标创建", selected_quote: "选中报价", sourced_from_rfq: "源自询价", about: "关联对象", fulfilled_by: "由发运履约", has_transport_event: "包含运输节点", received_as: "收货为", invoiced_by: "由发票结算",
};

const sourceLabels: Record<string, string> = {
  verified_external: "已核验的外部回执", approved_human: "已批准的人工事实", deterministic: "系统确定性记录", model_derived: "模型推导（非权威事实）", observed_backfill: "历史状态观察（非精确迁移时间）",
};

const missingFactLabels: Record<string, string> = {
  odoo_purchase_order: "Odoo 采购订单", supplier_confirmation: "供应商正式确认", production_progress: "生产 / 备货进度", shipment: "发运 / ASN", grn: "最终 GRN",
};

const projectionWarnings: Partial<Record<ManufacturingContextEnvelope["projectionStatus"], string>> = {
  lagging: "投影正在落后于来源；以下制造上下文可能未包含最新记录，采购事实仍以采购工作台为准。",
  degraded: "投影处于降级状态；以下制造上下文可能不完整，采购事实仍以采购工作台为准。",
  unavailable: "制造上下文投影当前不可用；请勿据此判断采购完成情况，采购事实仍以采购工作台为准。",
};

const projectionLabels: Record<ManufacturingContextEnvelope["projectionStatus"], string> = {
  current: "当前",
  lagging: "延迟",
  degraded: "降级",
  unavailable: "不可用",
};

const objects = (value: unknown): ContextRecord[] => Array.isArray(value)
  ? value.filter((item): item is ContextRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
  : [];

const text = (value: unknown, fallback = "—") => typeof value === "string" && value.trim() ? value : fallback;

export function contextValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return "无法显示"; }
}

export function manufacturingContextViewModel(envelope: ManufacturingContextEnvelope) {
  const data = envelope.data ?? {};
  const entities = objects(data.entities);
  const root = data.root && typeof data.root === "object" && !Array.isArray(data.root) ? data.root as ContextRecord : null;
  const entityById = new Map(entities.map((item) => [text(item.id, ""), item]));
  if (root) entityById.set(text(root.id, ""), root);
  const labeledEntities = entities.map((item): LabeledContextRecord => ({ ...item, typeLabel: entityLabels[text(item.entityType, "")] ?? text(item.entityType, "未分类实体") }));
  const relations = objects(data.relations).map((item): LabeledRelation => ({
    ...item,
    typeLabel: relationLabels[text(item.relationType, "")] ?? text(item.relationType, "未分类关系"),
    fromLabel: text(entityById.get(text(item.fromEntityId, ""))?.label, text(item.fromEntityId)),
    toLabel: text(entityById.get(text(item.toEntityId, ""))?.label, text(item.toEntityId)),
  }));
  const evidence = objects(data.evidence).map((item): LabeledEvidence => ({
    ...item,
    sourceLabel: sourceLabels[text(item.sourceSemantics, "")] ?? text(item.sourceSemantics, "来源未标注"),
    entityLabel: text(entityById.get(text(item.entityId, ""))?.label, text(item.entityId, "根实体")),
  }));
  const agentEvents = objects(data.agentEvents);
  const uniqueEntityIds = new Set(labeledEntities.map((item) => text(item.id, "")).filter(Boolean));
  if (root) uniqueEntityIds.add(text(root.id, "__root__"));
  return {
    root: root ? { ...root, typeLabel: entityLabels[text(root.entityType, "")] ?? text(root.entityType, "未分类实体") } as LabeledContextRecord : null,
    entities: labeledEntities,
    relations,
    evidence,
    missingFacts: envelope.missingFacts.map((code) => ({ code, label: missingFactLabels[code] ?? code })),
    conflicts: envelope.conflicts,
    agentEvents,
    summary: {
      entityCount: uniqueEntityIds.size,
      relationCount: relations.length,
      evidenceCount: evidence.length,
      missingFactCount: envelope.missingFacts.length,
      conflictCount: envelope.conflicts.length,
      agentEventCount: agentEvents.length,
    },
    projection: { status: envelope.projectionStatus, label: projectionLabels[envelope.projectionStatus], warning: projectionWarnings[envelope.projectionStatus] ?? null, sourceWatermark: envelope.sourceWatermark, truncated: envelope.truncated, nextCursor: envelope.nextCursor },
  };
}
