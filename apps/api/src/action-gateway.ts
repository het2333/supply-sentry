import type { DatabaseSync } from 'node:sqlite';
import type { ContextStore, RuntimeHub } from '@readywork/core';
import type { ConnectorExecutionContext, ConnectorExecutionResult } from '@readywork/connector-runtime';
import type { EditorNodeDef, EditorRunMode } from './editor.js';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import { redactSensitive, redactSensitiveValue } from './http-errors.js';

const ACTION_GATEWAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS action_executions (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
`;

export interface ActionGatewayInput {
  runId: string;
  tenantId: string;
  employeeId: string;
  node: EditorNodeDef;
  input: Record<string, unknown>;
  mode: EditorRunMode;
}

export interface ActionGatewayResult {
  ok: boolean;
  idempotencyKey: string;
  connector: string;
  action: string;
  output?: unknown;
  error?: string;
  replayed?: boolean;
  /** 仅表示外部动作确定尚未完成、允许由持久化队列再次尝试。 */
  retryable?: boolean;
  recoveryState?: 'manual_reconciliation';
}

interface ResolvedAction {
  connector: string;
  action: string;
  args: Record<string, unknown>;
}

export interface ActionConnectorPort {
  execute(connectorId: string, action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorExecutionResult>;
  getCredential(id: string, tenantId: string): Record<string, import('@readywork/graph-runtime').JsonValue> | undefined;
  /**
   * 对已过期的 ERP 写入做只读核验。返回 confirmed 之前绝不能重放 ERP 写操作，
   * 因为进程中断时外部系统可能已经完成了写入。
   */
  reconcile?(connectorId: string, action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<{ confirmed: boolean; output?: Record<string, unknown> }>;
}

const ERP_ACTIONS = new Set(['po.get', 'po.update', 'po.create_draft', 'rfq.create', 'rfq.award', 'invoice.update']);
const ACTION_LEASE_MIN_MS = 60_000;

/** 所有真实世界写操作的唯一入口：权限、模式、幂等与审计在这里收口。 */
export class ActionGateway {
  private inFlight = new Map<string, Promise<ActionGatewayResult>>();
  private memoryResults = new Map<string, ActionGatewayResult>();

  constructor(
    private db: DatabaseSync | undefined,
    private hub: RuntimeHub,
    private context: ContextStore,
    private connectors: ActionConnectorPort,
  ) {
    if (this.db) initializeControlPlaneSchema(this.db);
  }

  async execute(input: ActionGatewayInput): Promise<ActionGatewayResult> {
    if (input.mode !== 'autonomous' && input.mode !== 'supervised') throw new Error(`${input.mode} 模式禁止真实副作用`);
    const resolved = this.resolve(input.node, input.input);
    const idempotencyKey = `${input.runId}:${input.node.id}:${resolved.connector}.${resolved.action}`;
    const executionKey = `${input.tenantId}\u0000${idempotencyKey}`;
    const replay = this.readFinal(input.tenantId, idempotencyKey);
    if (replay) return { ...replay, replayed: true };
    const active = this.inFlight.get(executionKey);
    if (active) return { ...(await active), replayed: true };

    const employee = this.hub.org.getAI(input.employeeId);
    if (!employee) throw new Error(`AI 员工不存在: ${input.employeeId}`);
    if (employee.tenantId !== input.tenantId) throw new Error('AI 员工与副作用请求租户不一致');
    const spec = this.hub.specs.get(employee.specId);
    if (!spec) throw new Error(`员工 Spec 不存在: ${employee.specId}`);
    if (!this.hub.policy.can(spec.permissions, resolved.action, resolved.connector)) {
      const denied: ActionGatewayResult = { ok: false, idempotencyKey, connector: resolved.connector, action: resolved.action, error: `权限拒绝: ${resolved.connector}.${resolved.action}` };
      this.storeFinal(input, denied);
      return denied;
    }

    const reservation = this.reserve(input, idempotencyKey, resolved);
    if (!reservation.owner) {
      if (reservation.result) return { ...reservation.result, replayed: true };
      return { ok: false, idempotencyKey, connector: resolved.connector, action: resolved.action, error: '副作用正在处理中，请稍后查询运行状态', replayed: true };
    }

    const execution = reservation.recoveryRequired
      ? this.recoverExpiredReservation(input, resolved, idempotencyKey)
      : this.executeReserved(input, resolved, idempotencyKey);
    this.inFlight.set(executionKey, execution);
    try {
      return await execution;
    } finally {
      this.inFlight.delete(executionKey);
    }
  }

  private async executeReserved(input: ActionGatewayInput, resolved: ResolvedAction, idempotencyKey: string): Promise<ActionGatewayResult> {
    let normalized: ActionGatewayResult;
    try {
      const result = await this.connectors.execute(resolved.connector, resolved.action, resolved.args, this.connectorContext(input, idempotencyKey));
      if (!result.ok && isUncertainExternalWrite(resolved, result.error)) return this.reconcileUncertainExternalWrite(input, resolved, idempotencyKey);
      normalized = result.ok
        ? { ok: true, idempotencyKey, connector: resolved.connector, action: resolved.action, output: redactSensitiveValue(result.output) }
        : { ok: false, idempotencyKey, connector: resolved.connector, action: resolved.action, error: redactSensitive(result.error ?? '工具执行失败', 500), ...(isSafelyRetryable(result.error) ? { retryable: true } : {}) };
    } catch (error) {
      if (isUncertainExternalWrite(resolved, error)) return this.reconcileUncertainExternalWrite(input, resolved, idempotencyKey);
      normalized = { ok: false, idempotencyKey, connector: resolved.connector, action: resolved.action, error: redactSensitive(error, 500) || '工具执行失败', ...(isSafelyRetryable(error) ? { retryable: true } : {}) };
    }
    this.storeFinal(input, normalized);
    return normalized;
  }

  private resolve(node: EditorNodeDef, input: Record<string, unknown>): ResolvedAction {
    const label = node.label;
    if (node.type === 'connector.email.send_supplier_email') {
      const supplierId = String(input['supplier_id'] ?? input['supplierId'] ?? '');
      const supplier = supplierId ? this.context.getEntity(supplierId) : undefined;
      const to = input['to'] ?? input['supplierEmail'] ?? supplier?.attributes['email'];
      return { connector: 'email', action: 'send', args: required({ ...input, to, supplierId }, ['to', 'subject', 'body']) };
    }
    if (label.includes('邮件询价')) {
      return { connector: 'email', action: 'send', args: required(input, ['to', 'subject', 'body']) };
    }
    if (label.includes('催交沟通') || label.includes('催交信息')) {
      return { connector: 'email', action: 'send', args: required({ ...input, to: input['to'] ?? input['supplierEmail'] }, ['to', 'subject', 'body']) };
    }
    if (label.includes('ERP落单')) {
      return { connector: 'erp', action: 'rfq.award', args: required(input, ['rfqId', 'supplier']) };
    }
    if (label.includes('更新交期') || label.includes('交期更新')) {
      return { connector: 'erp', action: 'po.update', args: required({ ...input, id: input['id'] ?? input['poId'] }, ['id', 'promiseDate']) };
    }
    if (label.includes('应付台账')) {
      return { connector: 'erp', action: 'invoice.update', args: required({ ...input, id: input['id'] ?? input['invoiceId'], status: input['status'] ?? 'payable_approved' }, ['id', 'status']) };
    }
    if (label.includes('ERP回写')) {
      const action = trustedErpAction(node);
      const rawArgs = objectValue(input['args']) ?? input;
      if (action === 'invoice.update') return { connector: 'erp', action, args: invoiceUpdateArgs(rawArgs) };
      return { connector: 'erp', action, args: withoutActionControl(rawArgs) };
    }
    if (label.includes('WMS')) throw new Error('WMS Connector 尚未配置，已阻止真实写入');
    if (label.includes('台账')) return { connector: 'excel', action: 'appendRow', args: { sheet: String(input['sheet'] ?? '采购台账'), row: input } };
    throw new Error(`节点未声明可执行 Connector: ${node.id} ${node.label}`);
  }

  private readFinal(tenantId: string, idempotencyKey: string): ActionGatewayResult | undefined {
    if (!this.db) {
      const result = this.memoryResults.get(`${tenantId}\u0000${idempotencyKey}`);
      return result?.retryable ? undefined : result;
    }
    const row = this.db.prepare("SELECT status, json FROM action_executions WHERE tenant_id = ? AND idempotency_key = ? AND status IN ('completed','failed','manual_reconciliation')").get(tenantId, idempotencyKey) as { status: string; json: string } | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.json) as ActionGatewayResult;
    } catch {
      return { ok: false, idempotencyKey, connector: 'unknown', action: 'unknown', error: '历史副作用结果无法读取' };
    }
  }

  private reserve(input: ActionGatewayInput, idempotencyKey: string, resolved: ResolvedAction): { owner: boolean; recoveryRequired?: boolean; result?: ActionGatewayResult } {
    if (!this.db) return { owner: true };
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + Math.max(ACTION_LEASE_MIN_MS, (input.node.timeoutMs ?? 30_000) + 30_000)).toISOString();
    const pending: ActionGatewayResult = { ok: false, idempotencyKey, connector: resolved.connector, action: resolved.action, error: '副作用正在处理中' };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status,json,lease_expires_at,attempt FROM action_executions WHERE tenant_id=? AND idempotency_key=?').get(input.tenantId, idempotencyKey) as { status: string; json: string; lease_expires_at: string | null; attempt: number } | undefined;
      if (!row) {
        this.db.prepare("INSERT INTO action_executions (tenant_id,idempotency_key,run_id,node_id,status,json,created_at,lease_expires_at,attempt,updated_at) VALUES (?,?,?,?, 'pending', ?,?,?,?,?)").run(input.tenantId, idempotencyKey, input.runId, input.node.id, JSON.stringify(pending), nowIso, leaseExpiresAt, 1, nowIso);
        this.db.exec('COMMIT');
        return { owner: true };
      }
      if (['completed', 'failed', 'manual_reconciliation'].includes(row.status)) {
        this.db.exec('COMMIT');
        return { owner: false, result: this.parseStoredResult(row.json, idempotencyKey) };
      }
      if (row.status === 'retryable_failed') {
        const maximumAttempts = Math.max(1, Number(input.node.retries ?? 0) + 1);
        if (Number(row.attempt ?? 1) >= maximumAttempts) {
          const exhausted = { ...this.parseStoredResult(row.json, idempotencyKey), retryable: false };
          this.db.prepare("UPDATE action_executions SET status='failed',json=?,lease_expires_at=NULL,updated_at=? WHERE tenant_id=? AND idempotency_key=?")
            .run(JSON.stringify(exhausted), nowIso, input.tenantId, idempotencyKey);
          this.db.exec('COMMIT');
          return { owner: false, result: exhausted };
        }
        this.db.prepare("UPDATE action_executions SET status='pending',lease_expires_at=?,attempt=?,updated_at=? WHERE tenant_id=? AND idempotency_key=?")
          .run(leaseExpiresAt, Math.max(1, Number(row.attempt ?? 1)) + 1, nowIso, input.tenantId, idempotencyKey);
        this.db.exec('COMMIT');
        return { owner: true };
      }
      const leaseActive = Boolean(row.lease_expires_at && Date.parse(row.lease_expires_at) > now.getTime());
      if (leaseActive) {
        this.db.exec('COMMIT');
        return { owner: false };
      }
      const recoveryRequired = isExternalWrite(resolved);
      this.db.prepare('UPDATE action_executions SET status=?,json=?,lease_expires_at=?,attempt=?,updated_at=? WHERE tenant_id=? AND idempotency_key=?').run(recoveryRequired ? 'recovering' : 'pending', JSON.stringify(pending), leaseExpiresAt, Math.max(1, Number(row.attempt ?? 1)) + 1, nowIso, input.tenantId, idempotencyKey);
      this.db.exec('COMMIT');
      return { owner: true, recoveryRequired };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction was not opened */ }
      throw error;
    }
  }

  private storeFinal(input: ActionGatewayInput, result: ActionGatewayResult): void {
    const key = `${input.tenantId}\u0000${result.idempotencyKey}`;
    if (!this.db) {
      this.memoryResults.set(key, result);
      if (this.memoryResults.size > 1_000) this.memoryResults.delete(this.memoryResults.keys().next().value!);
      return;
    }
    const now = new Date().toISOString();
    const status = result.recoveryState === 'manual_reconciliation' ? 'manual_reconciliation' : result.ok ? 'completed' : result.retryable ? 'retryable_failed' : 'failed';
    this.db.prepare('INSERT INTO action_executions (tenant_id,idempotency_key,run_id,node_id,status,json,created_at,lease_expires_at,attempt,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,idempotency_key) DO UPDATE SET status=excluded.status,json=excluded.json,lease_expires_at=NULL,updated_at=excluded.updated_at').run(input.tenantId, result.idempotencyKey, input.runId, input.node.id, status, JSON.stringify(result), now, null, 1, now);
  }

  private async recoverExpiredReservation(input: ActionGatewayInput, resolved: ResolvedAction, idempotencyKey: string): Promise<ActionGatewayResult> {
    return this.reconcileUncertainExternalWrite(input, resolved, idempotencyKey, true);
  }

  private async reconcileUncertainExternalWrite(input: ActionGatewayInput, resolved: ResolvedAction, idempotencyKey: string, replayed = false): Promise<ActionGatewayResult> {
    try {
      const verified = await this.connectors.reconcile?.(resolved.connector, resolved.action, resolved.args, this.connectorContext(input, idempotencyKey));
      if (verified?.confirmed) {
        const result: ActionGatewayResult = { ok: true, idempotencyKey, connector: resolved.connector, action: resolved.action, output: redactSensitiveValue(verified.output ?? {}), ...(replayed ? { replayed: true } : {}) };
        this.storeFinal(input, result);
        return result;
      }
    } catch {
      // External reconciliation is intentionally fail-closed. The public result below is
      // stable and contains no connector exception or credential material.
    }
    const manual: ActionGatewayResult = {
      ok: false,
      idempotencyKey,
      connector: resolved.connector,
      action: resolved.action,
      error: `${resolved.connector === 'erp' ? 'ERP 写入' : '外部副作用'}在中断后无法核验，已转人工对账，未重放写操作`,
      recoveryState: 'manual_reconciliation',
    };
    this.storeFinal(input, manual);
    return manual;
  }

  private connectorContext(input: ActionGatewayInput, idempotencyKey: string): ConnectorExecutionContext {
    return {
      tenantId: input.tenantId,
      employeeId: input.employeeId,
      runId: input.runId,
      nodeRunId: `${input.runId}:${input.node.id}`,
      idempotencyKey,
      credentials: input.node.credentialRef ? this.connectors.getCredential(input.node.credentialRef, input.tenantId) ?? {} : {},
      timeoutMs: input.node.timeoutMs ?? 30_000,
    };
  }

  private parseStoredResult(json: string, idempotencyKey: string): ActionGatewayResult {
    try { return JSON.parse(json) as ActionGatewayResult; }
    catch { return { ok: false, idempotencyKey, connector: 'unknown', action: 'unknown', error: '历史副作用结果无法读取' }; }
  }
}

function required(input: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  for (const field of fields) {
    if (input[field] === undefined || input[field] === null || input[field] === '') throw new Error(`副作用输入缺少必填字段: ${field}`);
  }
  return input;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function withoutActionControl(input: Record<string, unknown>): Record<string, unknown> {
  const result = { ...input };
  delete result['action'];
  delete result['actions'];
  delete result['actionSuggestions'];
  return result;
}

function trustedErpAction(node: EditorNodeDef): string {
  const parameter = node.parameters?.['action'];
  const config = node.config?.['action'];
  if (parameter !== undefined && config !== undefined && parameter !== config) throw new Error('ERP 节点参数与配置中的 action 不一致');
  const action = typeof parameter === 'string' ? parameter : typeof config === 'string' ? config : '';
  if (!ERP_ACTIONS.has(action)) throw new Error('ERP 回写节点必须在已发布节点定义中配置允许的 action');
  if (node.label.includes('应付') && action !== 'invoice.update') throw new Error('应付 ERP 回写节点只允许 invoice.update');
  return action;
}

function invoiceUpdateArgs(input: Record<string, unknown>): Record<string, unknown> {
  const invoice = objectValue(input['invoice']);
  const invoiceId = input['invoiceId'] ?? input['id'] ?? invoice?.['id'];
  const disposition = typeof input['disposition'] === 'string' ? input['disposition'] : undefined;
  const explicitMatch = typeof input['matchResult'] === 'string' ? input['matchResult'] : undefined;
  if (disposition && explicitMatch && disposition !== explicitMatch) throw new Error('三单匹配结果与回写状态不一致');
  const matchResult = disposition ?? explicitMatch;
  if (!matchResult || !['exact_match', 'within_tolerance', 'approval_required', 'severe_exception'].includes(matchResult)) {
    throw new Error('应付 ERP 回写缺少受控的三单匹配结果');
  }
  const args: Record<string, unknown> = {
    invoiceId,
    matchResult,
  };
  if (matchResult === 'severe_exception') {
    // 即使图被误连到 ERP 节点，严重异常也绝不能标记可付款。
    args['payableStatus'] = 'hold';
    args['holdReason'] = '三单匹配严重异常，等待人工处理';
  } else if (matchResult === 'approval_required') {
    if (!hasTrustedApprovedAudit(input)) throw new Error('应付 ERP 回写缺少当前审批绑定的已批准结论');
    args['approvalStatus'] = 'approved';
    args['payableStatus'] = 'payable';
  } else {
    args['payableStatus'] = 'payable';
  }
  return required(args, ['invoiceId']);
}

function isErpWrite(action: string): boolean {
  return action !== 'po.get';
}

function isExternalWrite(resolved: ResolvedAction): boolean {
  if (resolved.connector === 'erp') return isErpWrite(resolved.action);
  if (resolved.connector === 'email') return resolved.action === 'send';
  // ActionGateway 不承载普通查询；其他适配器动作按外部副作用处理。
  return true;
}

function isUncertainExternalWrite(resolved: ResolvedAction, error: unknown): boolean {
  if (!isExternalWrite(resolved)) return false;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /\b(timeout|timed?\s*out|abort(?:ed|error)?|econnreset|connection\s+(?:reset|closed|terminated)|socket\s+hang\s+up|network\s+error|http\s*50[234])\b/i.test(message)
    || /(?:超时|连接被重置|连接已关闭|结果未知)/.test(message);
}

/** 只有能明确判定“外部系统还没有开始处理”的错误才能自动重试。 */
function isSafelyRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /\b(econnrefused|enotfound|eai_again|enetunreach|429|rate\s*limit(?:ed)?|too\s+many\s+requests|database\s+(?:is\s+)?(?:busy|locked))\b/i.test(message)
    || /(?:连接被拒绝|请求过多|服务繁忙|数据库(?:繁忙|已锁定))/.test(message);
}

function hasTrustedApprovedAudit(input: Record<string, unknown>): boolean {
  const audits = input['__readyworkApprovalAudit'];
  return Array.isArray(audits) && audits.some((entry) => {
    const audit = objectValue(entry);
    return audit?.['decision'] === 'approved' && typeof audit['decisionId'] === 'string' && typeof audit['nodeId'] === 'string';
  });
}
