import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { nowIso } from '@readywork/core';
import {
  TENANT_ID,
  createSupplyChainRuntime,
  erpOf,
  seedGoodsReceived,
  seedSupplier,
  seedSupplierEmail,
  syncObjectToContext,
} from '@readywork/supply-chain';
import type { SupplyChainRuntime } from '@readywork/supply-chain';

/**
 * Web Control Tower —— node:http 零依赖仪表盘。
 * 启动时预置演示数据（需求/询价完成，PO 停在延期审批），
 * 前端轮询 /api/*，可交互：审批通过、注入业务事件、重置演示数据。
 */

const rt = createSupplyChainRuntime();
const { hub, engine, tower, employees, humans } = rt;

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- 演示数据

async function seedDashboard(): Promise<void> {
  const erp = erpOf(rt);
  seedSupplier(rt, { id: 's:001', name: '苏州精密五金', email: 's001@precision.cn' });

  // ① 询价与报价员工（报价 → 中标 → 完成）
  const rfqBo = hub.objects.create({
    id: 'rfq:2001',
    type: 'rfq',
    status: 'draft',
    attributes: { item: '不锈钢紧固件 M6', qty: 20000, suppliers: 's1@supplier.cn,s2@supplier.cn,s3@supplier.cn' },
  });
  syncObjectToContext(rt, rfqBo);
  const rfqTask = await engine.runTask({ tenantId: TENANT_ID, employeeId: employees.procurement.id, workflowId: 'rfq-process', businessObjectId: rfqBo.id });
  for (const q of [
    { from: 's1@supplier.cn', body: 'M6 紧固件 单价 0.18 元 交期 10天' },
    { from: 's2@supplier.cn', body: 'M6 紧固件 单价 0.15 元 交期 15天' },
  ]) {
    rt.context.upsertEntity({ id: `email:${q.from}`, type: 'email', attributes: { from: q.from, subject: '报价', body: q.body } });
  }
  rt.hub.bus.emit({ type: 'context.event', eventType: 'quote_received', objectId: rfqBo.id, payload: {}, at: nowIso() });
  await new Promise((r) => setTimeout(r, 100));
  const rfqApproval = hub.approvals.listPending().find((a) => a.taskId === rfqTask.id);
  if (rfqApproval) await engine.approve(rfqTask.id, rfqApproval.id, humans.manager.id);

  // ③ PO 运营（停在延期审批，供交互）
  erp.pos.set('po:1001', { id: 'po:1001', item: '铝合金外壳', qty: 5000, unitPrice: 12.5, promiseDate: '2025-08-25', status: 'sent' });
  const poBo = hub.objects.create({
    id: 'po:1001',
    type: 'po',
    status: 'sent',
    attributes: { supplierId: 's:001', supplierName: '苏州精密五金', item: '铝合金外壳', qty: 5000, unitPrice: 12.5, promiseDate: '2025-08-25', poDate: '2025-08-18' },
  });
  syncObjectToContext(rt, poBo);
  const poTask = await engine.runTask({ tenantId: TENANT_ID, employeeId: employees.procurement.id, workflowId: 'po-operations', businessObjectId: poBo.id });
  seedSupplierEmail(rt, {
    from: 's001@precision.cn',
    subject: 'PO-1001 交期确认',
    body: '已收到 PO-1001，新交期确认为 2025-09-05，请知悉。',
    eventType: 'supplier_confirmed',
    objectId: poBo.id,
  });
  await new Promise((r) => setTimeout(r, 100));
  // PO 停在 waiting_approval（不自动批准）
  void poTask;
}

await seedDashboard();

// ---------------------------------------------------------------- 路由

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
      return;
    }
    if (method === 'GET' && path === '/api/tower/overview') return sendJson(res, 200, tower.overview());
    if (method === 'GET' && path === '/api/employees') {
      return sendJson(res, 200, employeesList(rt));
    }
    if (method === 'GET' && path === '/api/tasks') {
      const status = url.searchParams.get('status');
      return sendJson(res, 200, tower.tasks(status as never));
    }
    if (method === 'GET' && path === '/api/approvals/pending') return sendJson(res, 200, tower.pendingApprovals());
    if (method === 'GET' && path === '/api/events') return sendJson(res, 200, tower.recentEvents(80));

    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)\/(approve|resume)$/);
    if (taskMatch && method === 'POST') {
      const taskId = taskMatch[1]!;
      const op = taskMatch[2]!;
      const body = await readBody(req);
      if (op === 'approve') {
        const approvalId = String(body['approvalId'] ?? '');
        const by = String(body['by'] ?? 'h:procurement-manager');
        return sendJson(res, 200, await engine.approve(taskId, approvalId, by));
      }
      return sendJson(res, 200, await engine.resume(taskId));
    }
    if (method === 'POST' && path === '/api/events') {
      const body = await readBody(req);
      const eventType = String(body['eventType'] ?? '');
      if (!eventType) return sendJson(res, 400, { error: 'eventType 必填' });
      if (eventType === 'goods_received') seedGoodsReceived(rt, String(body['objectId'] ?? ''));
      else {
        hub.bus.emit({
          type: 'context.event',
          eventType,
          objectId: body['objectId'] !== undefined ? String(body['objectId']) : undefined,
          payload: (body['payload'] as Record<string, unknown> | undefined) ?? {},
          at: nowIso(),
        });
      }
      return sendJson(res, 200, { ok: true, eventType });
    }
    sendJson(res, 404, { error: `未找到路由: ${method} ${path}` });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

function employeesList(r: SupplyChainRuntime): unknown[] {
  return r.hub.org.listAI().map((e) => {
    const d = tower.employeeDetail(e.id);
    return {
      id: e.id,
      name: e.name,
      role: d.spec.role,
      status: e.status,
      manager: d.spec.humanEscalation.contactIds.length ? humans.manager.name : '—',
      kpi: {
        successRate: +(d.kpi.successRate * 100).toFixed(0),
        interventionRate: +(d.kpi.interventionRate * 100).toFixed(0),
        onTimeRate: +(d.kpi.onTimeRate * 100).toFixed(0),
        cost: +d.kpi.totalCost.toFixed(2),
      },
      stats: d.stats,
    };
  });
}

const PORT = Number(process.env['PORT'] ?? 4180);
server.listen(PORT, () => {
  console.log(`\n  AI Workforce OS · Control Tower → http://127.0.0.1:${PORT}\n`);
});

// ---------------------------------------------------------------- 前端

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Workforce OS · Control Tower</title>
<style>
  :root { --bg:#0b0f17; --card:#141a26; --line:#232c3d; --text:#e6edf3; --muted:#8b98a9; --green:#3fb950; --yellow:#d29922; --red:#f85149; --blue:#58a6ff; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,"PingFang SC",Segoe UI,Roboto,sans-serif; background:var(--bg); color:var(--text); }
  header { padding:20px 28px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; }
  h1 { font-size:18px; margin:0; } h1 small { color:var(--muted); font-weight:400; font-size:12px; margin-left:10px; }
  .wrap { padding:22px 28px; display:grid; gap:18px; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; }
  .card h2 { font-size:13px; margin:0 0 12px; color:var(--muted); font-weight:600; letter-spacing:.5px; text-transform:uppercase; }
  .stat-row { display:flex; gap:16px; flex-wrap:wrap; }
  .stat { background:#0f1520; border:1px solid var(--line); border-radius:8px; padding:10px 14px; min-width:96px; }
  .stat .n { font-size:22px; font-weight:700; } .stat .l { color:var(--muted); font-size:11px; margin-top:2px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; }
  .badge { padding:2px 8px; border-radius:99px; font-size:11px; }
  .idle{background:#1b2a1b;color:var(--green);} .working{background:#15233b;color:var(--blue);}
  .waiting_external{background:#2b2314;color:var(--yellow);} .waiting_approval{background:#2b1a14;color:#ff7b72;}
  .failed{background:#2b1416;color:var(--red);} .completed{background:#1b2a1b;color:var(--green);}
  .waiting_human{background:#232331;color:#bc8cff;}
  button { background:#1f6feb; color:#fff; border:0; border-radius:6px; padding:5px 12px; cursor:pointer; font-size:12px; }
  button:hover { background:#2f81f7; } button.ghost { background:transparent; border:1px solid var(--line); color:var(--muted); }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; color:var(--muted); }
  .events { max-height:260px; overflow:auto; }
  .events div { padding:4px 0; border-bottom:1px dashed #1c2432; }
</style>
</head>
<body>
<header>
  <h1>AI Workforce OS · Control Tower<small>控制塔</small></h1>
  <div id="clock" class="mono"></div>
</header>
<div class="wrap" id="root"></div>
<script>
const $ = (id) => document.getElementById(id);
const fmt = (n) => (typeof n === 'number' ? n.toFixed(2) : n);
async function api(path, opts) { const r = await fetch(path, opts); return r.json(); }

async function approve(taskId, approvalId) {
  await api('/api/tasks/' + taskId + '/approve', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ approvalId }) });
  render();
}
async function inject(type, objectId) {
  await api('/api/events', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ eventType:type, objectId }) });
  render();
}

function badge(s) { return '<span class="badge ' + s + '">' + s.replace(/_/g,' ') + '</span>'; }

async function render() {
  const [ov, emps, tasks, ap, ev] = await Promise.all([
    api('/api/tower/overview'), api('/api/employees'), api('/api/tasks'), api('/api/approvals/pending'), api('/api/events'),
  ]);
  $('clock').textContent = '刷新 ' + new Date().toLocaleTimeString();

  let html = '';
  html += '<div class="card"><h2>员工状态</h2><div class="stat-row">' +
    Object.entries(ov.employees.byStatus).map(([k,v]) => '<div class="stat"><div class="n">'+v+'</div><div class="l">'+k.replace(/_/g,' ')+'</div></div>').join('') +
    '</div></div>';
  html += '<div class="card"><h2>任务状态</h2><div class="stat-row">' +
    Object.entries(ov.tasks.byStatus).map(([k,v]) => '<div class="stat"><div class="n">'+v+'</div><div class="l">'+k.replace(/_/g,' ')+'</div></div>').join('') +
    '</div></div>';

  html += '<div class="card"><h2>AI 员工</h2><table><tr><th>员工</th><th>状态</th><th>成功率</th><th>介入率</th><th>准时率</th><th>成本</th></tr>' +
    emps.map(e => '<tr><td><b>'+e.name+'</b><div class="mono">'+e.role.slice(0,26)+'</div></td><td>'+badge(e.status)+'</td><td>'+e.kpi.successRate+'%</td><td>'+e.kpi.interventionRate+'%</td><td>'+e.kpi.onTimeRate+'%</td><td>¥'+e.kpi.cost+'</td></tr>').join('') +
    '</table></div>';

  html += '<div class="card"><h2>任务</h2><table><tr><th>任务</th><th>工作流</th><th>状态</th><th>重试</th></tr>' +
    tasks.map(t => '<tr><td class="mono">'+t.id.slice(0,14)+'</td><td>'+t.workflowId+'</td><td>'+badge(t.status)+'</td><td>'+t.attempts+'</td></tr>').join('') +
    '</table></div>';

  html += '<div class="card"><h2>待审批</h2>' +
    (ap.length ? ap.map(a => '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)"><div><b>'+a.title+'</b><div class="mono">'+JSON.stringify(a.payload).slice(0,70)+'</div></div><button data-approve="1" data-task="'+a.taskId+'" data-appr="'+a.id+'">批准</button></div>').join('') : '<div class="mono">无待审批</div>') +
    '</div>';

  html += '<div class="card"><h2>业务事件注入</h2>' +
    '<button data-inject="supplier_confirmed" data-obj="po:1001">供应商确认</button> ' +
    '<button data-inject="goods_received" data-obj="po:1001">到货</button> ' +
    '<button class="ghost" onclick="location.reload()">重置</button>' +
    '</div>';

  html += '<div class="card"><h2>事件流（最近）</h2><div class="events">' +
    ev.slice(-40).reverse().map(e => '<div class="mono">'+e.at.slice(11,19)+'  '+e.type+'</div>').join('') +
    '</div></div>';

  $('root').innerHTML = html;
}
// 事件委托：避免内联 onclick 的引号转义问题
$('root').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  if (b.dataset.approve) { approve(b.dataset.task, b.dataset.appr); return; }
  if (b.dataset.inject) { inject(b.dataset.inject, b.dataset.obj); return; }
});
render(); setInterval(render, 3000);
</script>
</body>
</html>`;
