import type { RuntimeHub, ContextStore } from '@readywork/core';
import { GovernanceService, poOperatorGovernance } from '@readywork/core';
import type { WorkflowEngine } from '@readywork/workflow';
import type { TowerService } from '@readywork/control-tower';
import type { ConnectorRegistry } from '@readywork/connectors';
import type { ToolRegistry } from '@readywork/tools';
import type { CollaborationControlPlane } from './collaboration-channels.js';
import { redactSensitive } from './http-errors.js';

/**
 * 企业聊天助手 —— 自然语言查询 + 控制 AI 员工。
 * 核心原则：聊天不能绕过权限。每个动作执行前都经过 GovernanceService 判定，
 * 允许才自动执行；需审批/禁止的，只返回决策结果，不执行。
 */

export interface ChatContext {
  hub: RuntimeHub;
  engine: WorkflowEngine;
  tower: TowerService;
  deployModes: Map<string, string>;
  connectors: ConnectorRegistry;
  context: ContextStore;
  tools: ToolRegistry;
  /** Optional until the HTTP control-plane adapter is wired. */
  collaboration?: CollaborationControlPlane;
}

export interface ChatHistoryItem { role: 'user' | 'assistant'; content: string; }

export interface ActionPlanItem {
  action: string;
  level: string;
  autoExecute: boolean;
  reason: string;
}

export interface ChatReply {
  reply: string;
  actions: string[];
  actionPlan: ActionPlanItem[];
}

interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string }; }

const FUNCTIONS = [
  { type: 'function', function: { name: 'overview', description: '查询全公司总览', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_employees', description: '列出所有 AI 员工及状态', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'employee_detail', description: '查看某员工详情', parameters: { type: 'object', properties: { employeeId: { type: 'string' } }, required: ['employeeId'] } } },
  { type: 'function', function: { name: 'list_tasks', description: '列出任务', parameters: { type: 'object', properties: { status: { type: 'string' } } } } },
  { type: 'function', function: { name: 'my_work', description: '仅列出当前会话人员或角色分配的待办', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'task_detail', description: '查看当前会话有权访问任务的完整上下文', parameters: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } } },
  { type: 'function', function: { name: 'collaboration_action', description: '接受、忽略或重新分配待办；必须先获得确认凭据，再二次确认提交', parameters: { type: 'object', properties: { taskId: { type: 'string' }, action: { type: 'string', enum: ['accept', 'dismiss', 'reassign'] }, idempotencyKey: { type: 'string' }, assigneeHumanId: { type: 'string' }, assigneeRole: { type: 'string' }, confirmationToken: { type: 'string' } }, required: ['taskId', 'action', 'idempotencyKey'] } } },
  { type: 'function', function: { name: 'list_approvals', description: '列出待审批', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_context', description: '查看知识实体', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_tools', description: '查看工具与连接器', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_po', description: '查询采购订单详情', parameters: { type: 'object', properties: { poId: { type: 'string' } }, required: ['poId'] } } },
  { type: 'function', function: { name: 'approve', description: '批准审批请求（采购经理）', parameters: { type: 'object', properties: { approvalId: { type: 'string' }, taskId: { type: 'string' } }, required: ['approvalId', 'taskId'] } } },
  { type: 'function', function: { name: 'reject', description: '拒绝审批请求', parameters: { type: 'object', properties: { approvalId: { type: 'string' }, taskId: { type: 'string' }, reason: { type: 'string' } }, required: ['approvalId', 'taskId'] } } },
  { type: 'function', function: { name: 'send_email', description: '发送邮件（催交/确认类）', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'subject', 'body'] } } },
  { type: 'function', function: { name: 'draft_email', description: '生成邮件草稿（不发送）', parameters: { type: 'object', properties: { subject: { type: 'string' }, body: { type: 'string' } }, required: ['subject', 'body'] } } },
  { type: 'function', function: { name: 'update_promise_date', description: '更新订单承诺交期', parameters: { type: 'object', properties: { poId: { type: 'string' }, date: { type: 'string' } }, required: ['poId', 'date'] } } },
  { type: 'function', function: { name: 'update_price', description: '修改采购价格', parameters: { type: 'object', properties: { poId: { type: 'string' }, price: { type: 'number' } }, required: ['poId', 'price'] } } },
  { type: 'function', function: { name: 'change_rule', description: '修改自动化规则阈值', parameters: { type: 'object', properties: { rule: { type: 'string' }, threshold: { type: 'string' } }, required: ['rule', 'threshold'] } } },
  { type: 'function', function: { name: 'set_deploy_mode', description: '切换员工部署模式', parameters: { type: 'object', properties: { employeeId: { type: 'string' }, mode: { type: 'string', enum: ['shadow', 'supervised', 'autonomous'] } }, required: ['employeeId', 'mode'] } } },
  { type: 'function', function: { name: 'add_capability', description: '给员工加技能/工具', parameters: { type: 'object', properties: { employeeId: { type: 'string' }, kind: { type: 'string', enum: ['skill', 'tool'] }, name: { type: 'string' } }, required: ['employeeId', 'kind', 'name'] } } },
];

const SYSTEM = `你是 AI Workforce OS 的企业助手。可以查询公司数据，也可以下达控制指令。

关键原则：聊天不能绕过权限。每个动作执行前会经过权限判定——允许才自动执行；需要审批或禁止的动作不会执行，只会返回决策结果。你看到工具返回 {"refused": true, ...} 时，要如实告知用户"该动作需要审批/被禁止"，并说明原因，绝不能假装已执行。

状态变更确认：看到工具返回 {"pendingConfirmation": true, ...} 时，说明这是"接受/拒绝/重新分配/发邮件/改交期"类状态变更操作，需要用户确认后才执行。你要明确告诉用户"该操作待你确认"，不要把它说成已执行。

规则：
1. 优先用函数获取真实数据，不要编造。
2. 涉及价格/数量/取消订单/授标/付款/改规则/加权限/切部署模式等高风险或管理动作，系统会拦下，你如实转达。
3. 用中文回答，简洁直接。`;

/** 状态变更类动作：第一轮只返回"待确认"，用户确认后才真正执行（对齐 Didero：所有状态变更需确认后生效） */
const STATE_CHANGING = new Set([
  'approve', 'reject', 'send_email', 'update_promise_date',
  'update_quantity', 'update_price', 'change_rule', 'set_deploy_mode', 'add_capability', 'collaboration_action',
]);

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export type ModelRoute = { model: string; complexity: 'fast' | 'reasoning' };

/** Keep routine lookups on the inexpensive model and reserve reasoning for multi-step/risk work. */
export function routeChatModel(message: string, history: ChatHistoryItem[]): ModelRoute {
  const complex = message.length > 240
    || history.length > 8
    || /(?:审批|授标|价格|付款|重新分配|异常|规则|为什么|分析|比较|风险|计划|多步骤)/.test(message);
  if (!complex) return { model: env('DEEPSEEK_FAST_MODEL', env('DEEPSEEK_MODEL', 'deepseek-v4-flash')), complexity: 'fast' };
  return { model: env('DEEPSEEK_REASONING_MODEL', env('DEEPSEEK_MODEL', 'deepseek-v4')), complexity: 'reasoning' };
}

function modelTimeoutMs(): number {
  const configured = Number(process.env['DEEPSEEK_TIMEOUT_MS'] ?? 20_000);
  return Number.isSafeInteger(configured) ? Math.min(Math.max(configured, 1_000), 120_000) : 20_000;
}

function modelApiBaseUrl(): string {
  return env('READYWORK_MODEL_BASE_URL', env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com'));
}

function modelApiKey(): string {
  return env('READYWORK_MODEL_API_KEY', env('DEEPSEEK_API_KEY', ''));
}

export function modelApiConfigured(): boolean {
  return Boolean(modelApiKey());
}

export class ModelRequestError extends Error {
  constructor(readonly kind: 'timeout' | 'upstream', message: string) { super(message); }
}

export function publicModelFailure(error: unknown): string {
  const safe = redactSensitive(error).toLowerCase();
  if (error instanceof ModelRequestError && error.kind === 'timeout' || /timeout|timed out|abort/.test(safe)) return '模型响应超时，请稍后重试。';
  return '模型服务暂不可用，请稍后重试。';
}

export async function deepseekChat(
  messages: unknown[],
  tools: unknown[],
  model: string,
  options: { readonly maxTokens?: number; readonly temperature?: number; readonly apiKey?: string; readonly jsonOutput?: boolean } = {},
): Promise<{ message: { content: string | null; tool_calls?: ToolCall[] }; usage?: Record<string, number> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), modelTimeoutMs());
  let res: Response;
  try {
    res = await fetch(`${modelApiBaseUrl()}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey ?? modelApiKey()}` },
      body: JSON.stringify({
        model,
        messages,
        ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        stream: false,
        ...(options.jsonOutput ? { response_format: { type: 'json_object' }, thinking: { type: 'disabled' } } : {}),
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      }), signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw new ModelRequestError('timeout', 'model request timed out');
    throw new ModelRequestError('upstream', redactSensitive(error));
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new ModelRequestError('upstream', `DeepSeek API ${res.status}`);
  try {
    const data = (await res.json()) as {
      choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
      usage?: Record<string, number>;
    };
    if (!data.choices[0]) throw new Error('empty model response');
    return { ...data.choices[0]!, ...(data.usage ? { usage: data.usage } : {}) };
  } catch (error) {
    throw new ModelRequestError('upstream', redactSensitive(error));
  }
}

const STATUS_ZH: Record<string, string> = { idle: '空闲', working: '执行中', waiting_external: '等待外部', waiting_approval: '审批中', waiting_human: '人工接管', failed: '失败', completed: '已完成', running: '执行中' };

/** 当前用户（actor）按角色能"要求"的动作类别 —— 员工权限之外的第一层闸门 */
const ACTOR_CATEGORIES: Record<string, string[]> = {
  '采购经理': ['read', 'analyze', 'internal', 'external_comm', 'erp_write'],
  '销售经理': ['read', 'analyze', 'internal', 'external_comm'],
  '采购专员': ['read', 'analyze', 'internal'],
  '管理员': ['read', 'analyze', 'internal', 'external_comm', 'erp_write', 'high_risk', 'admin'],
};

export function createChatHandler(ctx: ChatContext): (message: string, history: ChatHistoryItem[], actorId?: string, roleOverride?: string, confirm?: boolean) => Promise<ChatReply> {
  const { hub, engine, tower, deployModes, tools } = ctx;
  const gov = new GovernanceService(poOperatorGovernance());

  const contextFor = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (name === 'update_promise_date') {
      const poId = String(args['poId'] ?? '');
      const r = await tools.execute('erp', 'po.get', { poId }, { employeeId: 'ai:po-ops' });
      const cur = (r.data as { po?: { promiseDate?: string } } | undefined)?.po?.promiseDate;
      const newDate = String(args['date'] ?? '');
      if (cur && newDate) {
        const days = Math.round((Date.parse(newDate) - Date.parse(cur)) / 86_400_000);
        return { days };
      }
    }
    if (name === 'update_quantity') {
      const poId = String(args['poId'] ?? '');
      const r = await tools.execute('erp', 'po.get', { poId }, { employeeId: 'ai:po-ops' });
      const cur = Number((r.data as { po?: { qty?: number } } | undefined)?.po?.qty ?? 0);
      const newQty = Number(args['qty'] ?? cur);
      return { delta: newQty - cur };
    }
    return {};
  };

  const execute = async (name: string, args: Record<string, unknown>, actorId: string): Promise<unknown> => {
    switch (name) {
      case 'overview': { const ov = tower.overview(); return { 员工: ov.employees, 任务: ov.tasks, 总成本: hub.org.listAI().reduce((s, e) => s + e.stats.totalCost, 0) }; }
      case 'list_employees': return hub.org.listAI().map((e) => ({ id: e.id, name: e.name, status: STATUS_ZH[e.status] ?? e.status, successRate: `${Math.round((e.stats.tasksCompleted / Math.max(1, e.stats.tasksTotal)) * 100)}%`, cost: e.stats.totalCost }));
      case 'employee_detail': { const e = hub.org.getAI(String(args['employeeId'] ?? '')); if (!e) return { error: `员工不存在` }; const d = tower.employeeDetail(e.id); return { id: e.id, name: e.name, role: d.spec.role, status: STATUS_ZH[e.status] ?? e.status, kpi: d.kpi, skills: d.spec.skills, tools: d.spec.tools }; }
      case 'list_tasks': return hub.machine.list((args['status'] as never) ?? undefined).map((t) => ({ id: t.id, workflow: t.workflowId, employee: t.employeeId, status: t.status }));
      case 'my_work': return ctx.collaboration ? ctx.collaboration.myWork({ tenantId: hub.org.getHuman(actorId)?.tenantId ?? '', humanId: actorId, role: hub.org.getHuman(actorId)?.role ?? '' }) : { unavailable: true, code: 'COLLABORATION_UNAVAILABLE' };
      case 'task_detail': return ctx.collaboration ? ctx.collaboration.taskDetail({ tenantId: hub.org.getHuman(actorId)?.tenantId ?? '', humanId: actorId, role: hub.org.getHuman(actorId)?.role ?? '' }, String(args['taskId'] ?? '')) ?? { error: '任务不存在或无权访问' } : { unavailable: true, code: 'COLLABORATION_UNAVAILABLE' };
      case 'collaboration_action': return ctx.collaboration ? ctx.collaboration.requestAction({ tenantId: hub.org.getHuman(actorId)?.tenantId ?? '', humanId: actorId, role: hub.org.getHuman(actorId)?.role ?? '' }, {
        taskId: String(args['taskId'] ?? ''), action: String(args['action'] ?? '') as 'accept' | 'dismiss' | 'reassign', idempotencyKey: String(args['idempotencyKey'] ?? ''),
        ...(args['assigneeHumanId'] ? { assigneeHumanId: String(args['assigneeHumanId']) } : {}), ...(args['assigneeRole'] ? { assigneeRole: String(args['assigneeRole']) } : {}), ...(args['confirmationToken'] ? { confirmationToken: String(args['confirmationToken']) } : {}),
      }) : { unavailable: true, code: 'COLLABORATION_UNAVAILABLE' };
      case 'list_approvals': return hub.approvals.listPending().map((a) => ({ id: a.id, taskId: a.taskId, title: a.title, payload: a.payload }));
      case 'get_context': { const snap = ctx.context.snapshotFor('*', []); const counts: Record<string, number> = {}; for (const e of snap.entities) counts[e.type] = (counts[e.type] ?? 0) + 1; return { entityTypes: counts, relationshipCount: snap.relationships.length }; }
      case 'get_tools': return { tools: hub.workers.list().map((w) => w.name), connectors: ctx.connectors.list().map((c) => ({ id: c.id, name: c.name, status: c.status() })) };
      case 'get_po': { const r = await tools.execute('erp', 'po.get', { poId: String(args['poId'] ?? '') }, { employeeId: 'ai:po-ops' }); if (!r.ok) return r; const po = (r.data as { po?: Record<string, unknown> })?.po ?? {}; return { id: po['id'], item: po['item'], qty: po['qty'], status: po['status'], promiseDate: po['promiseDate'] }; }
      case 'approve': { const r = await engine.approve(String(args['taskId'] ?? ''), String(args['approvalId'] ?? ''), actorId); return { ok: true, taskStatus: r.status }; }
      case 'reject': { const r = await engine.reject(String(args['taskId'] ?? ''), String(args['approvalId'] ?? ''), actorId, String(args['reason'] ?? '')); return { ok: true, taskStatus: r.status }; }
      case 'send_email': {
        const to = String(args['to'] ?? '');
        // 参数级约束：收件人必须在供应商/客户白名单内，不能发给任意邮箱
        const snap = ctx.context.snapshotFor('*', []);
        const known = snap.entities.filter((e) => e.type === 'supplier' || e.type === 'customer').map((e) => String(e.attributes['email'] ?? '')).filter(Boolean);
        if (!known.includes(to)) return { ok: false, error: `收件人 ${to} 不在供应商/客户白名单中，拒绝发送` };
        const r = await tools.execute('email', 'send', { to, subject: String(args['subject'] ?? ''), body: String(args['body'] ?? '') }, { employeeId: 'ai:po-ops' });
        return r.ok ? { ok: true, realSent: r.data?.['realSent'], message: r.data?.['mailMessage'] ?? r.data } : r;
      }
      case 'draft_email': return { draft: `主题：${args['subject']}\n正文：${args['body']}`, note: '草稿，未发送' };
      case 'update_promise_date': { const r = await tools.execute('erp', 'po.update', { poId: String(args['poId'] ?? ''), field: 'promiseDate', value: String(args['date'] ?? '') }, { employeeId: 'ai:po-ops' }); return r.ok ? { ok: true, promiseDate: args['date'] } : r; }
      case 'update_price': return { ok: false, error: '修改价格需审批（工具层亦禁止）' };
      case 'change_rule': return { ok: false, error: '修改自动化规则需管理员确认' };
      case 'set_deploy_mode': { deployModes.set(String(args['employeeId'] ?? ''), String(args['mode'] ?? 'supervised')); return { ok: true, mode: args['mode'] }; }
      case 'add_capability': { const e = hub.org.getAI(String(args['employeeId'] ?? '')); const spec = e ? hub.specs.get(e.specId) : undefined; if (!spec) return { error: '员工不存在' }; const kind = String(args['kind'] ?? ''); const nm = String(args['name'] ?? ''); if (kind === 'skill' && !spec.skills.includes(nm)) spec.skills.push(nm); if (kind === 'tool' && !spec.tools.includes(nm)) spec.tools.push(nm); return { ok: true, skills: spec.skills, tools: spec.tools }; }
      default: return { error: `未知函数: ${name}` };
    }
  };

  return async (message: string, history: ChatHistoryItem[], actorId = 'h:procurement-manager', roleOverride?: string, confirm = false): Promise<ChatReply> => {
    if (!modelApiConfigured()) return { reply: '模型服务尚未配置。', actions: [], actionPlan: [] };
    const actor = hub.org.getHuman(actorId);
    const actorRole = roleOverride ?? actor?.role ?? '采购经理';
    const actorCats = ACTOR_CATEGORIES[actorRole] ?? ['read'];
    const messages: unknown[] = [{ role: 'system', content: SYSTEM }, ...history.map((h) => ({ role: h.role, content: h.content })), { role: 'user', content: message }];
    const actionPlan: ActionPlanItem[] = [];
    const actions: string[] = [];
    const route = routeChatModel(message, history);
    try {
      for (let i = 0; i < 6; i++) {
        const resp = await deepseekChat(messages, FUNCTIONS, route.model);
        const msg = resp.message;
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });
          for (const tc of msg.tool_calls) {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>; } catch { /* ignore */ }
            const decision = gov.check(tc.function.name, await contextFor(tc.function.name, args));
            let result: unknown;
            if (!actorCats.includes(decision.category)) {
              result = { refused: true, action: tc.function.name, reason: `当前用户（${actorRole}）无权要求该动作（${decision.category}）` };
              actionPlan.push({ action: tc.function.name, level: 'deny', autoExecute: false, reason: `当前用户（${actorRole}）无权要求` });
            } else if (!decision.autoExecute) {
              result = { refused: true, action: tc.function.name, level: decision.level, reason: decision.reason };
              actionPlan.push({ action: tc.function.name, level: decision.level, autoExecute: false, reason: decision.reason });
            } else if (!confirm && STATE_CHANGING.has(tc.function.name)) {
              // 状态变更：第一轮只返回"待确认"，不执行（对齐 Didero 的确认要求）
              result = { pendingConfirmation: true, action: tc.function.name, note: '状态变更操作，需你确认后执行' };
              actionPlan.push({ action: tc.function.name, level: 'confirm', autoExecute: false, reason: '状态变更需人工确认' });
            } else {
              try { result = await execute(tc.function.name, args, actorId); } catch (e) { result = { error: redactSensitive(e) }; }
              actionPlan.push({ action: tc.function.name, level: decision.level, autoExecute: true, reason: decision.reason });
            }
            actions.push(`${tc.function.name}(${tc.function.arguments.slice(0, 80)})`);
            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
          }
          continue;
        }
        return { reply: msg.content ?? '（无回复）', actions, actionPlan };
      }
      return { reply: '（处理轮次超限）', actions, actionPlan };
    } catch (e) {
      return { reply: publicModelFailure(e), actions, actionPlan };
    }
  };
}
