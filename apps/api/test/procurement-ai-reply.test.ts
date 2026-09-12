import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPersistence, createProcurementRepository } from '@readywork/persistence';
import { analyzeSupplierReplyWithModel, ingestInboundPurchaseOrderEmailWithAi } from '../src/procurement-ai-reply.js';
import { CredentialVault } from '@readywork/connector-runtime';

const at = '2026-09-05T00:00:00.000Z';
const body = '气动阀确认接单，数量200件，单价127元，2026年9月20日交货。';
const facts = { intent: 'confirmation', ambiguous: false, summary: '确认200件，单价127元，9月20日交货', lines: [{ poLineId: 'line:ai', quantity: { value: 200, quote: '数量200件' }, unitPrice: { value: 127, quote: '单价127元' }, promisedDate: { value: '2026-09-20', quote: '2026年9月20日交货' }, currency: 'CNY', currencyQuote: '127元', itemQuote: '气动阀' }] };
function setup() {
  const store = openPersistence(':memory:', { tenantId: 't:ai' });
  const repo = createProcurementRepository(store.db, 't:ai');
  repo.saveDocument('supplier', { id: 'supplier:ai', tenantId: 't:ai', sourceSystem: 'manual', externalId: 'S-AI', status: 'active', createdAt: at, updatedAt: at, name: '测试供应商', currency: 'CNY', contacts: [{ id: 'contact:ai', name: '联系人', email: 'supplier@example.com', primary: true }] });
  repo.saveDocument('purchase_order', { id: 'po:ai', tenantId: 't:ai', sourceSystem: 'manual', externalId: 'PO-90001', status: 'sent', createdAt: at, updatedAt: at, supplierId: 'supplier:ai', currency: 'CNY', orderedAt: at });
  repo.saveLine('purchase_order_line', 'po:ai', { id: 'line:ai', poId: 'po:ai', lineNumber: '10', itemId: 'PV-30', description: '气动阀', orderedQty: 200, unitPrice: 127, currency: 'CNY', uom: '件', requestedAt: '2026-09-20T00:00:00.000Z' });
  const input = { db: store.db, tenantId: 't:ai', provider: 'imap:test', mailbox: 'INBOX', poNumber: 'PO-90001', email: { id: 'uid:ai', from: 'supplier@example.com', subject: 'Re: PO-90001', body, receivedAt: at, messageId: '<ai-reply@example.com>' } };
  return { store, repo, input };
}

test('AI 路线只接受当前回复中明确且无冲突的境内或进口原文', async () => {
  const { store, repo } = setup();
  const po = repo.getDocument<any>('purchase_order', 'po:ai')!.document;
  const lines = repo.listLines<any>('purchase_order_line', po.id);
  const scenarios = [
    { body: '本订单为境内采购，由国内仓库发货。', route: 'local', quote: '本订单为境内采购', status: 'parsed', verified: 'local' },
    { body: '货物将从上海发货。', route: 'local', quote: '上海发货', status: 'review_required', verified: undefined },
    { body: '本订单为境内采购。', route: 'local', quote: '本订单属于境内采购', status: 'review_required', verified: undefined },
    { body: '本订单既写境内采购，又写进口采购，需要确认。', route: 'local', quote: '本订单既写境内采购，又写进口采购', status: 'review_required', verified: undefined },
    { body: '本订单为进口采购，需要办理清关。', route: 'import', quote: '本订单为进口采购', status: 'parsed', verified: 'import' },
  ] as const;
  try {
    for (const scenario of scenarios) {
      const candidate = { intent: 'other', ambiguous: false, summary: '路线说明', lines: [], route: { value: scenario.route, quote: scenario.quote } };
      const analysis = await analyzeSupplierReplyWithModel(
        { body: scenario.body, receivedAt: at, po, lines },
        { responder: async () => ({ content: JSON.stringify(candidate) }) },
      );
      assert.equal(analysis.status, scenario.status, scenario.body);
      assert.equal((analysis as any).verifiedRoute?.value, scenario.verified, scenario.body);
      if (scenario.verified) assert.equal((analysis as any).verifiedRoute?.quote, scenario.quote);
    }
  } finally { store.close(); }
});

test('AI 生产只接受有逐字段原文证据且不超过订单量的行级进度', async () => {
  const { store, repo } = setup();
  const po = repo.getDocument<any>('purchase_order', 'po:ai')!.document;
  const lines = repo.listLines<any>('purchase_order_line', po.id);
  const reply = '气动阀已生产完成，可发货。完成数量200件，完成度100%，2026年9月8日可发货。';
  const validLine = {
    poLineId: 'line:ai', itemQuote: '气动阀',
    progressStatus: { value: 'ready_to_ship', quote: '已生产完成，可发货' },
    completedQty: { value: 200, quote: '完成数量200件' },
    completionPercent: { value: 100, quote: '完成度100%' },
    expectedReadyDate: { value: '2026-09-08', quote: '2026年9月8日可发货' },
    note: null,
  };
  const scenarios = [
    { name: '完整', line: validLine, status: 'parsed', verified: true },
    { name: '缺数量', line: { ...validLine, completedQty: null }, status: 'review_required', verified: false },
    { name: '伪造完成度引用', line: { ...validLine, completionPercent: { value: 100, quote: '完成度为100%' } }, status: 'review_required', verified: false },
    { name: '超过订购量', line: { ...validLine, completedQty: { value: 201, quote: '完成数量200件' } }, status: 'review_required', verified: false },
  ] as const;
  try {
    for (const scenario of scenarios) {
      const candidate = { intent: 'progress', ambiguous: false, summary: scenario.name, lines: [], production: { lines: [scenario.line] } };
      const analysis = await analyzeSupplierReplyWithModel(
        { body: reply, receivedAt: at, po, lines },
        { responder: async () => ({ content: JSON.stringify(candidate) }) },
      );
      assert.equal(analysis.status, scenario.status, scenario.name);
      const verified = (analysis as any).verifiedProductionLines;
      assert.equal(Array.isArray(verified), scenario.verified, scenario.name);
      if (scenario.verified) assert.deepEqual(verified, [{
        poLineId: 'line:ai', quantity: 200, progressStatus: 'ready_to_ship', completionPercent: 100,
        expectedReadyAt: '2026-09-08T00:00:00.000Z',
      }]);
    }
  } finally { store.close(); }
});

test('AI 发运只接受 ASN、承运商、运单、ETA 和行级数量均有原文证据的结果', async () => {
  const { store, repo } = setup();
  const po = repo.getDocument<any>('purchase_order', 'po:ai')!.document;
  const lines = repo.listLines<any>('purchase_order_line', po.id);
  const reply = '气动阀已发运，发运数量200件。ASN: ASN-AI-001，承运商: DHL，运单号: DHL-TRACK-001，预计2026年9月12日到货。';
  const validShipment = {
    supplierReference: { value: 'ASN-AI-001', quote: 'ASN: ASN-AI-001' },
    carrier: { value: 'DHL', quote: '承运商: DHL' },
    trackingNumber: { value: 'DHL-TRACK-001', quote: '运单号: DHL-TRACK-001' },
    estimatedArrivalDate: { value: '2026-09-12', quote: '预计2026年9月12日到货' },
    lines: [{ poLineId: 'line:ai', itemQuote: '气动阀', quantity: { value: 200, quote: '发运数量200件' } }],
  };
  const scenarios = [
    { name: '完整', shipment: validShipment, status: 'parsed', verified: true },
    { name: '缺 ASN', shipment: { ...validShipment, supplierReference: null }, status: 'review_required', verified: false },
    { name: '伪造运单引用', shipment: { ...validShipment, trackingNumber: { value: 'DHL-TRACK-001', quote: '运单号: OTHER' } }, status: 'review_required', verified: false },
    { name: '超过订购量', shipment: { ...validShipment, lines: [{ ...validShipment.lines[0], quantity: { value: 201, quote: '发运数量200件' } }] }, status: 'review_required', verified: false },
  ] as const;
  try {
    for (const scenario of scenarios) {
      const candidate = { intent: 'progress', ambiguous: false, summary: scenario.name, lines: [], shipment: scenario.shipment };
      const analysis = await analyzeSupplierReplyWithModel(
        { body: reply, receivedAt: at, po, lines },
        { responder: async () => ({ content: JSON.stringify(candidate) }) },
      );
      assert.equal(analysis.status, scenario.status, scenario.name);
      const verified = (analysis as any).verifiedShipment;
      assert.equal(Boolean(verified), scenario.verified, scenario.name);
      if (scenario.verified) assert.deepEqual(verified, {
        supplierReference: 'ASN-AI-001', carrier: 'DHL', trackingNumber: 'DHL-TRACK-001',
        estimatedArrivalAt: '2026-09-12T00:00:00.000Z', lines: [{ poLineId: 'line:ai', quantity: 200 }],
      });
    }
  } finally { store.close(); }
});

test('一封供应商邮件完成路线承诺生产和发运且重放不重复写入', async () => {
  const { store, repo, input } = setup();
  let calls = 0;
  input.email.body = [
    '本订单为境内采购。',
    '气动阀确认接单，数量200件，单价127元，2026年9月20日交货。',
    '气动阀已生产完成，可发货，完成数量200件，完成度100%，2026年9月8日可发货。',
    '气动阀已发运，发运数量200件。ASN: ASN-FULL-001，承运商: DHL，运单号: DHL-FULL-001，预计2026年9月12日到货。',
  ].join('\n');
  const candidate = {
    ...facts,
    summary: '供应商确认境内采购并完成生产和发运',
    route: { value: 'local', quote: '本订单为境内采购' },
    production: { lines: [{
      poLineId: 'line:ai', itemQuote: '气动阀', progressStatus: { value: 'ready_to_ship', quote: '已生产完成，可发货' },
      completedQty: { value: 200, quote: '完成数量200件' }, completionPercent: { value: 100, quote: '完成度100%' },
      expectedReadyDate: { value: '2026-09-08', quote: '2026年9月8日可发货' }, note: null,
    }] },
    shipment: {
      supplierReference: { value: 'ASN-FULL-001', quote: 'ASN: ASN-FULL-001' },
      carrier: { value: 'DHL', quote: '承运商: DHL' },
      trackingNumber: { value: 'DHL-FULL-001', quote: '运单号: DHL-FULL-001' },
      estimatedArrivalDate: { value: '2026-09-12', quote: '预计2026年9月12日到货' },
      lines: [{ poLineId: 'line:ai', itemQuote: '气动阀', quantity: { value: 200, quote: '发运数量200件' } }],
    },
  };
  try {
    const responder = async () => { calls += 1; return { content: JSON.stringify(candidate), usage: { total_tokens: 456 } }; };
    const first = await ingestInboundPurchaseOrderEmailWithAi(input, { responder });
    assert.equal(first.analysis.status, 'applied', first.analysis.reason);
    assert.deepEqual((first.analysis as any).appliedFacts, ['route', 'confirmation', 'production', 'shipment']);
    assert.deepEqual((first.analysis as any).blockResults, {
      route: { status: 'applied' }, confirmation: { status: 'applied' }, production: { status: 'applied' }, shipment: { status: 'applied' },
    });
    assert.equal(repo.getDocument<any>('purchase_order', 'po:ai')?.document.status, 'shipped');
    const assignment = store.db.prepare('SELECT route,source,evidence_json,version FROM procurement_route_assignments WHERE tenant_id=? AND po_id=?')
      .get('t:ai', 'po:ai') as Record<string, unknown>;
    assert.equal(assignment['route'], 'local'); assert.equal(assignment['source'], 'supplier_email_ai'); assert.equal(assignment['version'], 1);
    assert.equal(JSON.parse(String(assignment['evidence_json'])).communicationId, first.communicationId);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM procurement_documents WHERE tenant_id=? AND kind='confirmation'").get('t:ai')?.['n'], 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM procurement_documents WHERE tenant_id=? AND kind='production_progress'").get('t:ai')?.['n'], 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM procurement_documents WHERE tenant_id=? AND kind='shipment'").get('t:ai')?.['n'], 1);
    const evidenceRows = store.db.prepare("SELECT kind,json FROM procurement_documents WHERE tenant_id=? AND kind IN ('production_progress','shipment') ORDER BY kind")
      .all('t:ai') as Array<{ kind: string; json: string }>;
    assert.ok(evidenceRows.every((row) => JSON.parse(row.json).evidenceSource === 'supplier_email_ai'));
    assert.ok(evidenceRows.every((row) => JSON.parse(row.json).evidenceReference === first.communicationId));

    const replay = await ingestInboundPurchaseOrderEmailWithAi(input, { responder: async () => { throw new Error('重放不应再次调用模型'); } });
    assert.equal(replay.analysis.status, 'applied');
    assert.equal(calls, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM procurement_documents WHERE tenant_id=? AND kind='production_progress'").get('t:ai')?.['n'], 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM procurement_documents WHERE tenant_id=? AND kind='shipment'").get('t:ai')?.['n'], 1);
  } finally { store.close(); }
});

test('生产解析优先使用当前租户加密密钥，不使用旧环境密钥或其他租户密钥', async (t) => {
  const { store, input } = setup();
  const oldSecret = process.env['READYWORK_CREDENTIAL_KEY'];
  const oldApiKey = process.env['DEEPSEEK_API_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'test-only-vault-secret-at-least-24-characters';
  process.env['DEEPSEEK_API_KEY'] = 'obsolete-test-key';
  const vault = new CredentialVault();
  for (const [tenant, key] of [['t:ai', 'current-tenant-test-key'], ['t:other', 'other-tenant-test-key']]) {
    store.db.prepare("INSERT INTO control_credentials (tenant_id,id,connector_id,credential_type,name,encrypted_json,status,created_at,updated_at) VALUES (?,'credential:ai:deepseek','deepseek','deepseekApiKey','test',?,'untested',?,?)")
      .run(tenant!, JSON.stringify(vault.encrypt({ apiKey: key! })), at, at);
  }
  let authorization: string | undefined;
  let requestBody: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    authorization = (init.headers as Record<string, string>)['authorization'] ?? '';
    requestBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(facts) } }], usage: { total_tokens: 123 } }));
  });
  try {
    const result = await ingestInboundPurchaseOrderEmailWithAi(input);
    assert.equal(authorization, 'Bearer current-tenant-test-key');
    assert.deepEqual(requestBody['thinking'], { type: 'disabled' }, '提取任务禁用耗尽输出预算的推理模式');
    assert.deepEqual(requestBody['response_format'], { type: 'json_object' });
    assert.equal(result.analysis.status, 'applied');
    assert.equal(JSON.stringify(result).includes('current-tenant-test-key'), false);
  } finally {
    if (oldSecret === undefined) delete process.env['READYWORK_CREDENTIAL_KEY']; else process.env['READYWORK_CREDENTIAL_KEY'] = oldSecret;
    if (oldApiKey === undefined) delete process.env['DEEPSEEK_API_KEY']; else process.env['DEEPSEEK_API_KEY'] = oldApiKey;
    store.close();
  }
});

test('DeepSeek 返回 401 时明确标记密钥无效，不伪装成普通模型故障', async (t) => {
  const { store, input } = setup();
  const previousSecret = process.env['READYWORK_CREDENTIAL_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'test-only-vault-secret-at-least-24-characters';
  const vault = new CredentialVault();
  store.db.prepare("INSERT INTO control_credentials (tenant_id,id,connector_id,credential_type,name,encrypted_json,status,created_at,updated_at) VALUES (?,'credential:ai:deepseek','deepseek','deepseekApiKey','test',?,'untested',?,?)")
    .run('t:ai', JSON.stringify(vault.encrypt({ apiKey: 'expired-deepseek-key' })), at, at);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    error: { message: 'Authentication Fails', type: 'authentication_error', code: 'invalid_request_error' },
  }), { status: 401, headers: { 'content-type': 'application/json' } }));
  try {
    const result = await ingestInboundPurchaseOrderEmailWithAi(input);
    assert.equal(result.analysis.status, 'failed');
    assert.equal(result.analysis.reason, 'DeepSeek API 密钥无效，请在设置中更新后重试。');
    assert.equal(result.analysis.reason.includes('expired-deepseek-key'), false);
    const persisted = store.db.prepare('SELECT error FROM procurement_ai_reply_analyses WHERE tenant_id=? AND communication_id=?')
      .get('t:ai', result.communicationId) as { error: string };
    assert.equal(persisted.error, result.analysis.reason);
  } finally {
    if (previousSecret === undefined) delete process.env['READYWORK_CREDENTIAL_KEY'];
    else process.env['READYWORK_CREDENTIAL_KEY'] = previousSecret;
    store.close();
  }
});

test('自动回信解析使用设置页最新保存的 DeepSeek 凭据，不依赖固定 ID', async (t) => {
  const { store, input } = setup();
  const previousSecret = process.env['READYWORK_CREDENTIAL_KEY'];
  const previousApiKey = process.env['DEEPSEEK_API_KEY'];
  process.env['READYWORK_CREDENTIAL_KEY'] = 'test-only-vault-secret-at-least-24-characters';
  process.env['DEEPSEEK_API_KEY'] = 'obsolete-environment-key';
  const vault = new CredentialVault();
  store.db.prepare("INSERT INTO control_credentials (tenant_id,id,connector_id,credential_type,name,encrypted_json,status,created_at,updated_at) VALUES (?,'credential:deepseek:default','deepseek','deepseekApiKey','settings',?,'connected',?,?)")
    .run('t:ai', JSON.stringify(vault.encrypt({ apiKey: 'settings-page-key' })), at, '2026-09-05T00:01:00.000Z');
  let authorization = '';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    authorization = String(
      (init.headers as Record<string, string | undefined>)['authorization'] ?? '',
    );
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(facts) } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  try {
    const result = await ingestInboundPurchaseOrderEmailWithAi(input);
    assert.equal(result.analysis.status, 'applied');
    assert.equal(authorization, 'Bearer settings-page-key');
  } finally {
    if (previousSecret === undefined) delete process.env['READYWORK_CREDENTIAL_KEY'];
    else process.env['READYWORK_CREDENTIAL_KEY'] = previousSecret;
    if (previousApiKey === undefined) delete process.env['DEEPSEEK_API_KEY'];
    else process.env['DEEPSEEK_API_KEY'] = previousApiKey;
    store.close();
  }
});

test('自然语言经过模型解析、原文校验、持久化确认；重放不重复调用模型或确认', async () => {
  const { store, repo, input } = setup(); let calls = 0;
  try {
    const responder = async (messages: unknown[]) => { calls++; assert.match(JSON.stringify(messages), /数量200件/); return { content: JSON.stringify(facts), usage: { total_tokens: 123 } }; };
    const result = await ingestInboundPurchaseOrderEmailWithAi(input, { responder });
    assert.equal(result.analysis.status, 'applied');
    assert.equal(repo.getDocument('purchase_order', 'po:ai')?.document.status, 'confirmed');
    const replay = await ingestInboundPurchaseOrderEmailWithAi(input, { responder });
    assert.equal(replay.analysis.status, 'applied'); assert.equal(calls, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM procurement_documents WHERE kind='confirmation'").get()!.n, 1);
    const persisted = store.db.prepare('SELECT result_json FROM procurement_ai_reply_analyses').get()!;
    assert.match(String(persisted.result_json), /数量200件/);
  } finally { store.close(); }
});

test('Odoo 已确认状态仍接收首份供应商承诺，但已有承诺后不重复推进', async () => {
  const { store, repo, input } = setup();
  try {
    const po = repo.getDocument('purchase_order', 'po:ai')!;
    repo.saveDocument('purchase_order', { ...po.document, sourceSystem: 'odoo', status: 'confirmed' }, po.version);

    const first = await ingestInboundPurchaseOrderEmailWithAi(input, {
      responder: async () => ({ content: JSON.stringify(facts), usage: { total_tokens: 101 } }),
    });
    assert.equal(first.analysis.status, 'applied');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM procurement_documents WHERE tenant_id=? AND kind='confirmation' AND json_extract(json,'$.poId')=?")
      .get('t:ai', 'po:ai')!.n, 1);
    assert.equal(store.db.prepare("SELECT state FROM procurement_po_stage_events WHERE tenant_id=? AND po_id=? AND stage='supplier_commitment' AND event_type='confirmation_accepted'")
      .get('t:ai', 'po:ai')?.['state'], 'completed');

    input.email.id = 'uid:ai:second';
    input.email.messageId = '<ai-reply-second@example.com>';
    const second = await ingestInboundPurchaseOrderEmailWithAi(input, {
      responder: async () => ({ content: JSON.stringify(facts), usage: { total_tokens: 102 } }),
    });
    assert.equal(second.analysis.status, 'already_confirmed');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM procurement_documents WHERE tenant_id=? AND kind='confirmation' AND json_extract(json,'$.poId')=?")
      .get('t:ai', 'po:ai')!.n, 1);
  } finally { store.close(); }
});

for (const scenario of ['missing', 'fabricated', 'quoted', 'wrong_sender', 'unavailable', 'variance', 'concurrent_edit'] as const) {
  test(`AI 回信保护：${scenario}`, async () => {
    const { store, repo, input } = setup(); let called = false;
    try {
      const output = structuredClone(facts);
      if (scenario === 'missing') output.lines[0]!.unitPrice = null as never;
      if (scenario === 'fabricated') output.lines[0]!.quantity = { value: 900, quote: '数量900件' };
      if (scenario === 'quoted') input.email.body = '尚不能确认\n------------------ 原始邮件 ------------------\n' + body;
      if (scenario === 'wrong_sender') input.email.from = 'attacker@example.net';
      if (scenario === 'variance') { input.email.body = body.replace('200件', '180件'); output.lines[0]!.quantity = { value: 180, quote: '数量180件' }; }
      const run = () => ingestInboundPurchaseOrderEmailWithAi(input, { responder: async () => {
        called = true;
        if (scenario === 'unavailable') throw Error('model offline');
        if (scenario === 'concurrent_edit') {
          const po = repo.getDocument('purchase_order', 'po:ai')!;
          repo.saveDocument('purchase_order', { ...po.document, status: 'cancelled' }, po.version);
        }
        return { content: JSON.stringify(output) };
      } });
      if (scenario === 'wrong_sender') { await assert.rejects(run); assert.equal(called, false); }
      else {
        const result = await run();
        assert.equal(result.analysis.status, scenario === 'variance' ? 'approval_required' : scenario === 'unavailable' ? 'failed' : 'review_required');
        assert.notEqual(repo.getDocument('purchase_order', 'po:ai')?.document.status, 'confirmed');
      }
    } finally { store.close(); }
  });
}

for (const sample of [
  { name: 'QQ 原始日期头、两位年份和口语块', text: '200件，每件127块，26年9.20交货', dateQuote: '26年9.20交货', date: '2026-09-20', priceQuote: '每件127块', currencyQuote: '块', status: 'applied' },
  { name: '模型单独引用127块也有数值依据', text: '200件，每件127块，26年9.20交货', dateQuote: '26年9.20交货', date: '2026-09-20', priceQuote: '127块', currencyQuote: '块', status: 'applied' },
  { name: '无年份交期使用规范化收信年份', text: '200件，每件127元，9.20交货', dateQuote: '9.20交货', date: '2026-09-20', priceQuote: '每件127元', currencyQuote: '元', status: 'applied' },
  { name: '不能忽略明示27年而接受2026', text: '200件，每件127元，27年9.20交货', dateQuote: '27年9.20交货', date: '2026-09-20', priceQuote: '每件127元', currencyQuote: '元', status: 'review_required' },
  { name: '明示27年按2027处理且延期仍需审批', text: '200件，每件127元，27年9.20交货', dateQuote: '27年9.20交货', date: '2027-09-20', priceQuote: '每件127元', currencyQuote: '元', status: 'approval_required' },
  { name: '外币语境中的块不能自动变成人民币', text: '200件，每件127块美元，26年9.20交货', dateQuote: '26年9.20交货', date: '2026-09-20', priceQuote: '每件127块', currencyQuote: '块', status: 'review_required' },
] as const) {
  test(`口语回信校验：${sample.name}`, async () => {
    const { store, repo, input } = setup();
    input.email.body = sample.text + '\n------------------ 原始邮件 ------------------\n' + body;
    input.email.receivedAt = 'Sat, 5 Sep 2026 23:36:20 +0800';
    const output = structuredClone(facts);
    Object.assign(output.lines[0]!, { quantity: { value: 200, quote: '200件' }, unitPrice: { value: 127, quote: sample.priceQuote }, promisedDate: { value: sample.date, quote: sample.dateQuote }, currencyQuote: sample.currencyQuote });
    try {
      const result = await ingestInboundPurchaseOrderEmailWithAi(input, { responder: async () => ({ content: JSON.stringify(output) }) });
      assert.equal(result.analysis.status, sample.status, result.analysis.reason);
      assert.equal(repo.getDocument('purchase_order', 'po:ai')?.document.status === 'confirmed', sample.status === 'applied');
      if (sample.status === 'applied') {
        assert.deepEqual(result.analysis.lines, [{ poLineId: 'line:ai', quantity: 200, unitPrice: 127, promisedAt: '2026-09-20T00:00:00.000Z' }]);
        assert.equal((await ingestInboundPurchaseOrderEmailWithAi(input, { responder: async () => { throw Error('重复邮件不应再次调模型'); } })).analysis.status, 'applied');
        assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM procurement_documents WHERE kind='confirmation'").get()!.n, 1);
      }
    } finally { store.close(); }
  });
}
