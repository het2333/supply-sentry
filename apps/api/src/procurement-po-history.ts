type Row = Readonly<Record<string, unknown>>;

export type PoHistoryEventSource = 'activity' | 'outbox' | 'amendment' | 'stage' | 'route' | 'route_evidence' | 'sla' | 'import_document' | 'quantity';

export type PoHistoryAdditionalSources = Readonly<{
  stageEvents?: readonly unknown[];
  routeEvents?: readonly unknown[];
  routeEvidenceEvents?: readonly unknown[];
  slaEvents?: readonly unknown[];
  importDocumentEvents?: readonly unknown[];
  quantityEvents?: readonly unknown[];
}>;

export type PoHistoryEvent = Readonly<{
  id: string;
  type: string;
  typeLabel: string;
  label: string;
  at: string | null;
  actor: string | null;
  source: PoHistoryEventSource;
  state: string | null;
  summary: string | null;
  evidence?: Row;
}>;

const actionLabels: Readonly<Record<string, string>> = {
  'po.reviewed': '采购订单复核',
  'purchase_order.edited': '采购订单修改',
  'purchase_order.cancelled': '采购订单取消',
  'purchase_order.amendment_applied': '采购订单修改应用',
  'purchase_order.duplicated': '采购订单复制',
  'purchase_order.created_from_duplicate': '从副本创建采购订单',
  'purchase_order.marked_at_risk': '采购订单风险标记',
  'purchase_order.odoo_draft_created': 'Odoo 采购订单草稿创建',
  'purchase_order.rihd_updated': '要求到货日更新',
  'purchase_order.send': '采购订单发送',
  'purchase_order.followup': '采购订单跟进',
  'purchase_order.create_draft': 'Odoo 采购订单草稿创建',
  'purchase_order.update_rihd': '要求到货日更新',
  'purchase_order.amend': '采购订单修改',
  'purchase_order.cancel': '采购订单取消',
  'purchase_order.draft_email.send': '采购邮件草稿发送',
  'purchase_order.draft_whatsapp.send': '采购 WhatsApp 草稿发送',
  'rfq.send': '询价单发送',
  'invoice.update': '发票状态回写',
  record_confirmation: '供应商确认登记',
  record_production_progress: '生产进度登记',
  record_shipment: '发运事实登记',
  record_transport_event: '运输节点登记',
  record_receipt: '到货事实登记',
  'task.created': '任务创建',
  'task.started': '任务开始',
  'task.waiting': '任务等待',
  'task.resumed': '任务恢复',
  'task.waiting_approval': '任务等待审批',
  'task.approved': '任务审批通过',
  'task.rejected': '任务审批驳回',
  'task.completed': '任务完成',
  'task.failed': '任务失败',
  'task.retrying': '任务重试',
  'task.handed_off': '任务移交',
  'task.handoff_finished': '任务移交完成',
  'task.cancelled': '任务取消',
  'approval.requested': '审批请求',
  'employee.status_changed': '员工状态变更',
  'tool.called': '工具调用',
  'budget.recorded': '预算记录',
  'context.event': '业务事件',
  stage_entered: '采购阶段进入',
  confirmation_evidence_received: '收到确认证据',
  confirmation_accepted: '供应商确认已接受',
  connector_delivery_confirmed: '连接器交付已确认',
  observed_document_status: '已观测单据状态',
  sla_breach: 'SLA 超时',
  sla_breached: 'SLA 超时',
  'sla.breached': 'SLA 超时',
  sla_escalated: 'SLA 升级',
  'sla.escalated': 'SLA 升级',
  'procurement_sla_evaluation.changed': 'SLA 评估更新',
  'procurement_sla_evaluation.deleted': 'SLA 评估删除',
  route_assigned: '采购路径分配',
  route_reassigned: '采购路径重新分配',
  route_evidence_bound: '采购路径证据绑定',
  route_evidence_uploaded: '采购路径证据上传',
  route_evidence_revoked: '采购路径证据撤销',
  route_unclassified_due_to_evidence_revocation: '采购路径因证据撤销待重新分类',
  supplier_difference_received: '收到供应商差异',
  evaluation_created: 'SLA 评估创建',
  evaluation_changed: 'SLA 评估更新',
  evaluation_deleted: 'SLA 评估删除',
  document_bound: '进口单证绑定',
  document_replaced: '进口单证替换',
  document_revoked: '进口单证撤销',
  manual_purchase_order_risk: '采购订单人工风险',
  'procurement_outbox.changed': '外部任务状态更新',
};

const stateLabels: Readonly<Record<string, string>> = {
  requested: '已申请',
  queued: '已排队',
  pending: '待处理',
  processing: '处理中',
  dispatched: '已提交外部系统',
  applied: '已应用',
  completed: '已完成',
  blocked: '已阻断',
  failed: '失败',
  rejected: '已驳回',
  cancelled: '已取消',
  unknown: '状态待核验',
  recorded: '已记录',
  active: '生效',
  breached: '已超时',
};

const quantityLabels: Readonly<Record<string, string>> = {
  confirmed: '确认数量更新',
  shipped: '发运数量更新',
  received: '收货数量更新',
  invoiced: '开票数量更新',
  cancelled: '取消数量更新',
};

function row(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function jsonObject(value: unknown): Row {
  if (typeof value !== 'string') return row(value);
  try {
    return row(JSON.parse(value));
  } catch {
    return {};
  }
}

function safeName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const printable = [...value].filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  }).join('').trim();
  return printable.slice(0, 120) || fallback;
}

function originalNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function firstOriginalNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = originalNonEmptyString(value);
    if (text !== null) return text;
  }
  return null;
}

function originalBusinessText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function businessSummary(value: Row): string | null {
  return firstOriginalNonEmptyString(value['summary'], value['reason'], value['note'], value['notes']);
}

function normalizedType(source: PoHistoryEventSource, action: string, state: string | null): string {
  const known: Readonly<Record<string, string>> = {
    'po.reviewed': 'purchase_order_reviewed',
    'purchase_order.followup': 'purchase_order_followup',
    edit: 'purchase_order_amendment',
    cancel: 'purchase_order_cancellation',
  };
  const base = known[action] ?? action;
  return source === 'amendment' ? `${base}_${state ?? 'recorded'}` : base;
}

function actionTypeLabel(source: PoHistoryEventSource, action: string): string {
  if (source === 'amendment' && action === 'edit') return '采购订单修改';
  if (source === 'amendment' && action === 'cancel') return '采购订单取消';
  return actionLabels[action] ?? action;
}

function withState(typeLabel: string, state: string | null): string {
  return state ? `${typeLabel}（${stateLabels[state] ?? safeName(state, '未知状态')}）` : typeLabel;
}

function projectActivity(value: unknown, index: number): PoHistoryEvent {
  const item = row(value);
  const action = safeName(item['action'], '未知事件');
  const state = originalNonEmptyString(item['state']);
  const typeLabel = actionTypeLabel('activity', action);
  return {
    id: originalNonEmptyString(item['id']) ?? `activity:${index}:${action}`,
    type: normalizedType('activity', action, state),
    typeLabel,
    label: withState(typeLabel, state),
    at: originalNonEmptyString(item['at']),
    actor: originalNonEmptyString(item['actor']),
    source: 'activity',
    state,
    summary: originalBusinessText(item['summary']),
  };
}

function projectOutbox(value: unknown, index: number): PoHistoryEvent {
  const item = row(value);
  const action = safeName(item['action'], '未知外部任务');
  const state = firstOriginalNonEmptyString(item['status'], item['state']);
  const typeLabel = actionTypeLabel('outbox', action);
  return {
    id: originalNonEmptyString(item['id']) ?? `outbox:${index}:${action}`,
    type: normalizedType('outbox', action, state),
    typeLabel,
    label: withState(typeLabel, state),
    at: firstOriginalNonEmptyString(item['updatedAt'], item['createdAt']),
    actor: null,
    source: 'outbox',
    state,
    summary: originalBusinessText(item['summary'] ?? item['reason']),
  };
}

function projectAmendment(value: unknown, index: number): PoHistoryEvent {
  const item = row(value);
  const action = safeName(item['action'], '未知采购订单变更');
  const state = originalNonEmptyString(item['state']) ?? 'recorded';
  const typeLabel = actionTypeLabel('amendment', action);
  return {
    id: originalNonEmptyString(item['id']) ?? `amendment:${index}:${action}`,
    type: normalizedType('amendment', action, state),
    typeLabel,
    label: withState(typeLabel, state),
    at: firstOriginalNonEmptyString(item['applied_at'], item['updated_at'], item['created_at']),
    actor: originalNonEmptyString(item['actor_id']),
    source: 'amendment',
    state,
    summary: originalBusinessText(item['reason'] ?? item['summary']),
  };
}

function projectStageEvent(value: unknown, index: number): PoHistoryEvent {
  const item = row(value);
  const action = safeName(item['event_type'], '未知采购阶段事件');
  const state = originalNonEmptyString(item['state']);
  const details = jsonObject(item['evidence_json']);
  const typeLabel = actionLabels[action] ?? action;
  return {
    id: originalNonEmptyString(item['id']) ?? `stage:${index}:${action}`,
    type: action,
    typeLabel,
    label: withState(typeLabel, state),
    at: originalNonEmptyString(item['occurred_at']),
    actor: originalNonEmptyString(item['actor_id']),
    source: 'stage',
    state,
    summary: businessSummary(details),
    evidence: {
      sourceKind: originalNonEmptyString(item['source_kind']),
      sourceId: originalNonEmptyString(item['source_id']),
      details,
    },
  };
}

function isInferredDocumentStatusObservation(value: unknown): boolean {
  const item = row(value);
  if (item['event_type'] !== 'observed_document_status' || item['source_kind'] !== 'document_snapshot') return false;
  return jsonObject(item['evidence_json'])['exactTransitionTime'] === false;
}

function projectRouteEvent(value: unknown, index: number): PoHistoryEvent {
  const item = row(value);
  const action = safeName(item['action'], '未知采购路径事件');
  const details = jsonObject(item['detail_json']);
  const state = originalNonEmptyString(details['status']);
  const typeLabel = actionLabels[action] ?? action;
  return {
    id: originalNonEmptyString(item['id']) ?? `route:${index}:${action}`,
    type: action,
    typeLabel,
    label: withState(typeLabel, state),
    at: originalNonEmptyString(item['created_at']),
    actor: originalNonEmptyString(item['actor_id']),
    source: 'route',
    state,
    summary: businessSummary(details),
    evidence: { details },
  };
}

function projectRouteEvidenceEvent(value: unknown, index: number): PoHistoryEvent {
  const item = row(value);
  const action = safeName(item['action'], '未知采购路径证据事件');
  const details = jsonObject(item['detail_json']);
  const state = originalNonEmptyString(details['status']);
  const typeLabel = actionLabels[action] ?? action;
  return {
    id: originalNonEmptyString(item['id']) ?? `route-evidence:${index}:${action}`,
    type: action,
    typeLabel,
    label: withState(typeLabel, state),
    at: originalNonEmptyString(item['created_at']),
    actor: originalNonEmptyString(item['actor_id']),
    source: 'route_evidence',
    state,
    summary: businessSummary(details),
    evidence: {
      documentId: originalNonEmptyString(item['document_id']),
      details,
    },
  };
}

function projectSlaEvent(value: unknown, index: number): PoHistoryEvent {
  const item = row(value);
  const action = safeName(item['action'], '未知 SLA 事件');
  const details = jsonObject(item['detail_json']);
  const state = originalNonEmptyString(details['status']);
  const typeLabel = actionLabels[action] ?? action;
  return {
    id: originalNonEmptyString(item['id']) ?? `sla:${index}:${action}`,
    type: action,
    typeLabel,
    label: withState(typeLabel, state),
    at: originalNonEmptyString(item['created_at']),
    actor: originalNonEmptyString(details['actorId']),
    source: 'sla',
    state,
    summary: businessSummary(details),
    evidence: {
      policyId: originalNonEmptyString(item['policy_id']),
      ruleId: originalNonEmptyString(item['rule_id']),
      details,
    },
  };
}

function projectImportDocumentEvent(value: unknown, index: number): PoHistoryEvent {
  const item = row(value);
  const action = safeName(item['action'], '未知进口单证事件');
  const details = jsonObject(item['detail_json']);
  const state = originalNonEmptyString(details['status']);
  const typeLabel = actionLabels[action] ?? action;
  return {
    id: originalNonEmptyString(item['id']) ?? `import-document:${index}:${action}`,
    type: action,
    typeLabel,
    label: withState(typeLabel, state),
    at: originalNonEmptyString(item['created_at']),
    actor: originalNonEmptyString(item['actor_id']),
    source: 'import_document',
    state,
    summary: businessSummary(details),
    evidence: {
      importDocumentId: originalNonEmptyString(item['import_document_id']),
      details,
    },
  };
}

function projectQuantityEvent(value: unknown, index: number): PoHistoryEvent {
  const item = row(value);
  const sourceSystem = originalNonEmptyString(item['source_system']);
  const sourceEventId = originalNonEmptyString(item['source_event_id']);
  const dimension = safeName(item['dimension'], '未知数量');
  const details = jsonObject(item['json']);
  const typeLabel = quantityLabels[dimension] ?? dimension;
  const delta = typeof item['delta'] === 'number' && Number.isFinite(item['delta']) ? item['delta'] : null;
  return {
    id: sourceSystem && sourceEventId ? `quantity:${sourceSystem}:${sourceEventId}` : `quantity:${index}:${dimension}`,
    type: `procurement_po_line_quantity.${dimension}`,
    typeLabel,
    label: typeLabel,
    at: originalNonEmptyString(item['occurred_at']),
    actor: null,
    source: 'quantity',
    state: null,
    summary: businessSummary(details),
    evidence: {
      poLineId: originalNonEmptyString(item['po_line_id']),
      sourceSystem,
      sourceEventId,
      dimension,
      delta,
      details,
    },
  };
}

export function buildPoHistoryEvents(
  activities: readonly unknown[],
  outbox: readonly unknown[],
  amendmentRows: readonly unknown[],
  additionalSources: PoHistoryAdditionalSources = {},
): PoHistoryEvent[] {
  return [
    ...activities.map(projectActivity),
    ...outbox.map(projectOutbox),
    ...amendmentRows.map(projectAmendment),
    ...(additionalSources.stageEvents ?? [])
      // Imported document status is evidence for the stage timeline, but it is
      // not an exact transition or a user/system business activity for History.
      .filter((event) => !isInferredDocumentStatusObservation(event))
      .map(projectStageEvent),
    ...(additionalSources.routeEvents ?? []).map(projectRouteEvent),
    ...(additionalSources.routeEvidenceEvents ?? []).map(projectRouteEvidenceEvent),
    ...(additionalSources.slaEvents ?? []).map(projectSlaEvent),
    ...(additionalSources.importDocumentEvents ?? []).map(projectImportDocumentEvent),
    ...(additionalSources.quantityEvents ?? []).map(projectQuantityEvent),
  ].sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? ''))
    || left.id.localeCompare(right.id));
}
