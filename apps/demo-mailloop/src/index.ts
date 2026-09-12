/**
 * 真实邮件闭环（IMAP 收信）验证 —— 用本地最小 IMAP 邮箱证明「真收信」代码链路正确：
 *   催交(真 Odoo 单) → 供应商回信落入 IMAP 收件箱 → ImapClient 拉取 → 按单号路由
 *   → 触发 supplier_confirmed → 恢复 PO 任务 → 提取新交期 → 延期审批 → 真回写 Odoo。
 *
 * 网易 163 IMAP 因账号「Unsafe Login」被拦，故用本地明文 IMAP 服务器演示同一套协议；
 * 打通后把 ImapConfig 换成 imap.163.com:993 即可（代码零改动）。
 *
 * 用法：pnpm demo:mailloop
 */
import { createServer, type Socket } from 'node:net';
import { createSupplyChainRuntime, seedSupplier, syncObjectToContext, TENANT_ID } from '@readywork/supply-chain';
import { OdooErpClient, ImapClient, pollInboundMail } from '@readywork/connectors';
import type { InboundEmail } from '@readywork/connectors';

const log = console.log;
const info = (...a: unknown[]) => log('   ', ...a);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const section = (t: string) => log(`\n${'═'.repeat(70)}\n  ${t}\n${'═'.repeat(70)}`);
const addDays = (iso: string, d: number) => { const x = new Date(iso); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
const requiredEnv = (k: string) => {
  const value = process.env[k];
  if (!value) throw new Error(`缺少环境变量 ${k}`);
  return value;
};

// ---------------------------------------------------------------- 最小本地 IMAP 服务器（明文）

function startMockImap(port: number, rawEmail: Buffer): Promise<() => void> {
  return new Promise((resolve) => {
    const server = createServer((sock: Socket) => {
      let seen = false;
      sock.setEncoding('utf8');
      sock.write('* OK readywork mock imap ready\r\n');
      let buf = '';
      sock.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = line.match(/^([A-Z]\d+)\s+(.+)$/);
          if (!m) continue;
          const t = m[1]!;
          const cmd = m[2]!;
          if (/^LOGIN/i.test(cmd)) sock.write(`${t} OK LOGIN completed\r\n`);
          else if (/^SELECT/i.test(cmd)) sock.write(`* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n${t} OK [READ-WRITE] SELECT completed\r\n`);
          else if (/^UID SEARCH/i.test(cmd)) sock.write(`* SEARCH ${seen ? '' : '1'}\r\n${t} OK SEARCH completed\r\n`);
          else if (/^UID FETCH/i.test(cmd)) {
            const uid = cmd.match(/FETCH (\d+)/)?.[1] ?? '1';
            sock.write(`* 1 FETCH (UID ${uid} BODY[] {${rawEmail.length}}\r\n`);
            sock.write(rawEmail);
            sock.write(`)\r\n${t} OK FETCH completed\r\n`);
          } else if (/^UID STORE/i.test(cmd)) {
            seen = true;
            sock.write(`* 1 FETCH (FLAGS (\\Seen))\r\n${t} OK STORE completed\r\n`);
          } else if (/^LOGOUT/i.test(cmd)) {
            sock.write(`* BYE logging out\r\n${t} OK LOGOUT completed\r\n`);
            sock.end();
          } else {
            sock.write(`${t} OK done\r\n`);
          }
        }
      });
    });
    server.listen(port, '127.0.0.1', () => resolve(() => server.close()));
  });
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  const PO_NAME = process.env['ODOO_PO_NAME'] ?? 'P00011';
  const odoo = new OdooErpClient({
    baseUrl: process.env['ODOO_BASE_URL'] ?? 'http://127.0.0.1:8069',
    database: process.env['ODOO_DATABASE'] ?? 'zhuxu_demo',
    apiKey: requiredEnv('ODOO_API_KEY'),
  });

  section('① 读 Odoo 采购单 + 建运行时');
  const po = await odoo.readPO(PO_NAME);
  if (!po) {
    info(`Odoo 未找到 ${PO_NAME}，中止`);
    return;
  }
  const baseline = po.promiseDate ? po.promiseDate.slice(0, 10) : '2026-09-05';
  const newEta = addDays(baseline, 15); // 供应商回信：比原承诺再晚 15 天
  info(`Odoo ${po.name}（${po.supplierName}）原交期 ${baseline}，供应商将回复新交期 ${newEta}`);

  const rawEmail = Buffer.from(
    `From: supplier@demo.cn\r\nSubject: ${PO_NAME} 交期确认\r\nDate: Wed, 19 Aug 2026 15:00:00 +0800\r\n\r\n已收到 ${PO_NAME}，新交期确认为 ${newEta}，请知悉。\r\n`,
    'utf8',
  );

  section('② 起本地 IMAP 邮箱（含供应商回信）+ 跑采购订单运营流程');
  const close = await startMockImap(1993, rawEmail);
  info('本地 IMAP 监听 127.0.0.1:1993，收件箱已有一封未读回信');
  const rt = createSupplyChainRuntime({ odoo });
  const { hub, engine, employees, humans } = rt;
  seedSupplier(rt, { id: po.supplierId, name: po.supplierName, email: po.supplierEmail || 'supplier@demo.cn' });
  const bo = hub.objects.create({
    id: po.name,
    type: 'po',
    status: 'sent',
    attributes: { supplierId: po.supplierId, supplierName: po.supplierName, item: po.lines[0]?.product, qty: po.lines[0]?.qty, promiseDate: po.promiseDate, poDate: po.dateOrder },
  });
  syncObjectToContext(rt, bo);
  const task = await engine.runTask({ tenantId: TENANT_ID, employeeId: employees.procurement.id, workflowId: 'po-operations', businessObjectId: bo.id });
  info(`任务 ${task.id} → ${task.status}（已读 Odoo ${po.name}，等待供应商回信）`);

  section('③ IMAP 真收信 → 按单号路由 → 触发 supplier_confirmed');
  const imap = await ImapClient.connect({ host: '127.0.0.1', port: 1993, user: 'x', pass: 'x', secure: false });
  const handled = await pollInboundMail(imap, async (email: InboundEmail, poNumber: string | null) => {
    if (!poNumber) return false;
    const b = hub.objects.get(poNumber);
    if (!b) return;
    rt.context.upsertEntity({ id: `email:${email.id}`, type: 'email', attributes: { from: email.from, subject: email.subject, body: email.body } });
    rt.context.recordEvidence({ entityId: poNumber, source: `imap:${email.from}`, summary: email.subject });
    rt.hub.bus.emit({ type: 'context.event', eventType: 'supplier_confirmed', objectId: poNumber, payload: { from: email.from }, at: new Date().toISOString() });
  });
  await imap.logout();
  info(`IMAP 拉取并路由 ${handled} 封回信 → 触发 supplier_confirmed → 恢复任务`);
  await sleep(300);
  const resumed = hub.machine.get(task.id);
  info(`任务 → ${resumed?.status}（提取新交期 ${newEta} → 延期 15 天 > 7 → 进入审批）`);

  section('④ 人工批准 + 真回写 Odoo');
  const approval = hub.approvals.listPending().find((a) => a.taskId === task.id);
  if (approval) {
    info(`审批「${approval.title}」payload=${JSON.stringify(approval.payload)} → ${humans.manager.name} 批准`);
    await engine.approve(task.id, approval.id, humans.manager.id);
    await sleep(300);
  }
  const after = await odoo.readPO(PO_NAME);
  const changed = (after?.promiseDate ?? '').slice(0, 10) === newEta;
  info(`Odoo ${after?.name} 交期：${baseline} → ${after?.promiseDate?.slice(0, 10)}`);
  info(changed ? '✅ 真收信闭环跑通：IMAP 收信 → 路由 → 解析 → 审批 → Odoo 交期真的变了' : '❌ 交期未变');

  close();
  log('\n完成 — 真实邮件闭环（本地 IMAP 验证同一套协议）。');
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
