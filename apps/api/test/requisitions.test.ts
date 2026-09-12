import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openPersistence } from '@readywork/persistence';
import { resolveSession, type Session } from '../src/auth.js';
import { handleRequisitionRequest } from '../src/requisitions.js';

const SESSION_SECRET = process.env['READYWORK_SESSION_SECRET'] ?? 'readywork-local-session-secret-change-in-production';

function signSession(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  const signature = createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `rw1.${payload}.${signature}`;
}

function payload(source: 'manual' | 'erp' | 'excel', suffix: string): Record<string, unknown> {
  return {
    source,
    externalId: `REQ-${suffix}`,
    departmentId: 'dept:procurement',
    currency: 'cny',
    lines: [{
      item: `item:${suffix}`,
      quantity: 12.5,
      uom: 'EA',
      targetDate: '2026-09-30T00:00:00.000Z',
      technicalRequirements: '耐高温，RoHS 合规',
    }],
  };
}

test('Requisition 业务 API: 校验、鉴权、租户隔离与幂等契约', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rw-requisition-api-'));
  const store = openPersistence(join(dir, 'test.db'), { tenantId: 'tenant:bootstrap' });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers['authorization'];
    const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    void handleRequisitionRequest(req, res, url.pathname, req.method ?? 'GET', {
      db: store.db,
      session: resolveSession(bearer),
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    }).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const buyerSession: Session = {
    username: 'buyer', tenantId: 't:acme', humanId: 'h:buyer-1', name: '李采购', role: '采购专员', expiresAt: Date.now() + 60_000,
  };
  const buyer = { token: signSession(buyerSession), session: buyerSession };
  const tenantBToken = signSession({
    username: 'buyer-b', tenantId: 'tenant:b', humanId: 'human:b', name: '租户 B 采购员', role: '采购专员', expiresAt: Date.now() + 60_000,
  });

  async function request(
    method: string,
    path: string,
    options: { token?: string; key?: string; body?: Record<string, unknown> } = {},
  ): Promise<{ status: number; body: Record<string, any> }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.key ? { 'idempotency-key': options.key } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  try {
    await t.test('未授权访问返回 401', async () => {
      assert.equal((await request('GET', '/api/requisitions')).status, 401);
      assert.equal((await request('POST', '/api/requisitions', { key: 'anonymous', body: payload('manual', 'anonymous') })).status, 401);
    });

    await t.test('空值和不完整申请返回 400', async () => {
      const invalidBodies = [
        {},
        { source: '', lines: [{}] },
        { source: 'manual', lines: [] },
        { source: 'manual', lines: [{ item: '', quantity: 1, uom: 'EA', targetDate: '2026-09-30' }] },
        { source: 'manual', lines: [{ item: 'item:1', quantity: 0, uom: 'EA', targetDate: '2026-09-30' }] },
        { source: 'manual', lines: [{ item: 'item:1', quantity: 1, uom: '', targetDate: '2026-09-30' }] },
        { source: 'manual', lines: [{ item: 'item:1', quantity: 1, uom: 'EA', targetDate: '' }] },
      ];
      for (const [index, body] of invalidBodies.entries()) {
        const response = await request('POST', '/api/requisitions', { token: buyer.token, key: `invalid-${index}`, body });
        assert.equal(response.status, 400, JSON.stringify(response.body));
      }
      const missingKey = await request('POST', '/api/requisitions', { token: buyer.token, body: payload('manual', 'missing-key') });
      assert.equal(missingKey.status, 400);
      assert.equal(missingKey.body['code'], 'IDEMPOTENCY_KEY_REQUIRED');
    });

    const ids = new Map<string, string>();
    await t.test('manual、erp、excel 均可创建并完整返回申请行', async () => {
      for (const source of ['manual', 'erp', 'excel'] as const) {
        const response = await request('POST', '/api/requisitions', {
          token: buyer.token,
          key: `create-${source}`,
          body: payload(source, source),
        });
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(response.body['replayed'], false);
        assert.equal(response.body['requisition'].source, source);
        assert.equal(response.body['requisition'].requesterId, buyer.session.humanId);
        assert.equal(response.body['requisition'].currency, 'CNY');
        assert.equal(response.body['requisition'].lines[0].item, `item:${source}`);
        assert.equal(response.body['requisition'].lines[0].quantity, 12.5);
        assert.deepEqual(response.body['requisition'].lines[0].attachments, []);
        ids.set(source, response.body['requisition'].id);
      }
    });

    await t.test('列表与单条读取返回当前租户数据', async () => {
      const listed = await request('GET', '/api/requisitions', { token: buyer.token });
      assert.equal(listed.status, 200);
      assert.equal(listed.body['items'].length, 3);
      const manualId = ids.get('manual');
      assert.ok(manualId);
      const one = await request('GET', `/api/requisitions/${encodeURIComponent(manualId)}`, { token: buyer.token });
      assert.equal(one.status, 200);
      assert.equal(one.body['requisition'].id, manualId);
      assert.equal(one.body['requisition'].lines[0].technicalRequirements, '耐高温，RoHS 合规');
    });

    await t.test('相同键与相同载荷重放原申请，不重复创建', async () => {
      const duplicate = await request('POST', '/api/requisitions', {
        token: buyer.token,
        key: 'create-manual',
        body: payload('manual', 'manual'),
      });
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.body['replayed'], true);
      assert.equal(duplicate.body['requisition'].id, ids.get('manual'));
      const listed = await request('GET', '/api/requisitions', { token: buyer.token });
      assert.equal(listed.body['items'].length, 3);
    });

    await t.test('相同键与不同载荷返回 409', async () => {
      const changed = payload('manual', 'manual');
      (changed['lines'] as Array<Record<string, unknown>>)[0]!['quantity'] = 99;
      const conflict = await request('POST', '/api/requisitions', { token: buyer.token, key: 'create-manual', body: changed });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body['code'], 'IDEMPOTENCY_KEY_REUSED');
    });

    await t.test('跨租户无法读取，列表和幂等键也相互隔离', async () => {
      const manualId = ids.get('manual');
      assert.ok(manualId);
      const hidden = await request('GET', `/api/requisitions/${encodeURIComponent(manualId)}`, { token: tenantBToken });
      assert.equal(hidden.status, 404);
      const empty = await request('GET', '/api/requisitions', { token: tenantBToken });
      assert.equal(empty.status, 200);
      assert.equal(empty.body['items'].length, 0);
      const created = await request('POST', '/api/requisitions', {
        token: tenantBToken,
        key: 'create-manual',
        body: payload('manual', 'manual'),
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.notEqual(created.body['requisition'].id, manualId);
    });

    await t.test('控制台主契约可直接 create → list → get，无字段转换缺口', async () => {
      const missingAllTargetDates = await request('POST', '/api/procurement/requisitions', {
        token: buyer.token,
        body: {
          idempotencyKey: 'ui-missing-target', source: 'manual', title: '缺少交期',
          requestingDepartment: '生产部', requesterName: '张工', currency: 'CNY',
          lines: [{ itemCode: 'M6', itemName: 'M6 螺栓', quantity: 1, unit: '件' }],
        },
      });
      assert.equal(missingAllTargetDates.status, 400);

      const uiPayload = {
        idempotencyKey: 'ui-create-1',
        source: 'manual',
        title: '生产线 M6 紧固件采购',
        requestingDepartment: '生产部',
        requesterName: '张工',
        currency: 'CNY',
        targetDeliveryDate: '2026-10-15',
        lines: [{
          itemCode: '',
          itemName: 'M6 不锈钢螺栓',
          quantity: 500,
          unit: '件',
          technicalRequirements: '304 不锈钢，配套螺母',
        }],
      };
      const created = await request('POST', '/api/procurement/requisitions', { token: buyer.token, body: uiPayload });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body['title'], uiPayload.title);
      assert.equal(created.body['requestingDepartment'], uiPayload.requestingDepartment);
      assert.equal(created.body['requesterName'], uiPayload.requesterName);
      assert.equal(created.body['lines'][0].itemCode, '');
      assert.equal(created.body['lines'][0].itemName, uiPayload.lines[0]!.itemName);
      assert.equal(created.body['lines'][0].unit, '件');
      assert.equal(created.body['lines'][0].quantity, 500);

      const listed = await request('GET', '/api/procurement/requisitions', { token: buyer.token });
      assert.equal(listed.status, 200);
      const summary = listed.body['items'].find((item: Record<string, unknown>) => item['id'] === created.body['id']);
      assert.ok(summary);
      assert.equal(summary.title, uiPayload.title);
      assert.equal(summary.requestingDepartment, uiPayload.requestingDepartment);

      const detail = await request('GET', `/api/procurement/requisitions/${encodeURIComponent(created.body['id'])}`, { token: buyer.token });
      assert.equal(detail.status, 200);
      assert.equal(detail.body['id'], created.body['id']);
      assert.equal(detail.body['lines'][0].itemName, uiPayload.lines[0]!.itemName);
      assert.equal(detail.body['lines'][0].targetDate, '2026-10-15T00:00:00.000Z');
    });

    await t.test('需求附件真实保存内容、版本、哈希、行关联和审计', async () => {
      const ghostAttachment = await request('POST', '/api/requisitions', {
        token: buyer.token,
        key: 'ghost-attachment',
        body: {
          source: 'manual', externalId: 'REQ-GHOST', departmentId: 'dept:procurement', currency: 'CNY',
          lines: [{ item: 'item:ghost', quantity: 1, uom: '件', targetDate: '2026-11-01', attachments: [{ id: 'attachment:ghost', fileName: 'ghost.pdf', contentType: 'application/pdf', sizeBytes: 1 }] }],
        },
      });
      assert.equal(ghostAttachment.status, 422);
      assert.equal(ghostAttachment.body['code'], 'ATTACHMENT_UPLOAD_REQUIRED');

      const created = await request('POST', '/api/procurement/requisitions', {
        token: buyer.token,
        body: {
          idempotencyKey: 'ui-attachment-requisition', source: 'manual', title: '带图纸的定制件需求',
          requestingDepartment: '生产部', requesterName: '张工', currency: 'CNY', targetDeliveryDate: '2026-11-01',
          lines: [{ itemCode: 'CUSTOM-1', itemName: '定制支架', quantity: 20, unit: '件' }],
        },
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const requisitionId = String(created.body['id']);
      const requisitionLineId = String(created.body['lines'][0].id);
      const firstContent = Buffer.from('定制支架 Rev.A：材质 304，厚度 2mm', 'utf8');
      const firstBody = {
        idempotencyKey: 'attachment-upload-1', fileName: '定制支架规格.txt', contentType: 'text/plain', sizeBytes: firstContent.length,
        dataBase64: firstContent.toString('base64'), requisitionLineId,
      };
      const uploaded = await request('POST', `/api/procurement/requisitions/${encodeURIComponent(requisitionId)}/attachments`, { token: buyer.token, body: firstBody });
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
      assert.equal(uploaded.body['attachment'].version, 1);
      assert.equal(uploaded.body['attachment'].requisitionLineId, requisitionLineId);
      assert.equal(uploaded.body['attachment'].extractionStatus, 'text_extracted');
      assert.equal(uploaded.body['attachment'].sha256.length, 64);

      const replay = await request('POST', `/api/procurement/requisitions/${encodeURIComponent(requisitionId)}/attachments`, { token: buyer.token, body: firstBody });
      assert.equal(replay.status, 200);
      assert.equal(replay.body['replayed'], true);
      assert.equal(replay.body['attachment'].id, uploaded.body['attachment'].id);

      const secondContent = Buffer.from('定制支架 Rev.B：增加安装孔', 'utf8');
      const versionTwo = await request('POST', `/api/procurement/requisitions/${encodeURIComponent(requisitionId)}/attachments`, {
        token: buyer.token,
        body: { ...firstBody, idempotencyKey: 'attachment-upload-2', sizeBytes: secondContent.length, dataBase64: secondContent.toString('base64') },
      });
      assert.equal(versionTwo.status, 201, JSON.stringify(versionTwo.body));
      assert.equal(versionTwo.body['attachment'].version, 2);

      const listed = await request('GET', `/api/procurement/requisitions/${encodeURIComponent(requisitionId)}/attachments`, { token: buyer.token });
      assert.equal(listed.status, 200);
      assert.equal(listed.body['items'].length, 2);
      assert.equal(listed.body['audit'].filter((event: Record<string, unknown>) => event['action'] === 'uploaded').length, 2);

      const contentResponse = await fetch(`${baseUrl}${uploaded.body['attachment'].url}`, { headers: { authorization: `Bearer ${buyer.token}` } });
      assert.equal(contentResponse.status, 200);
      assert.equal(await contentResponse.text(), firstContent.toString('utf8'));
      assert.equal(contentResponse.headers.get('x-content-type-options'), 'nosniff');
      const hidden = await fetch(`${baseUrl}${uploaded.body['attachment'].url}`, { headers: { authorization: `Bearer ${tenantBToken}` } });
      assert.equal(hidden.status, 404);

      const invalidLine = await request('POST', `/api/procurement/requisitions/${encodeURIComponent(requisitionId)}/attachments`, {
        token: buyer.token,
        body: { ...firstBody, idempotencyKey: 'attachment-wrong-line', requisitionLineId: 'requisition-line:other' },
      });
      assert.equal(invalidLine.status, 400);
      const blocked = await request('POST', `/api/procurement/requisitions/${encodeURIComponent(requisitionId)}/attachments`, {
        token: buyer.token,
        body: { idempotencyKey: 'attachment-blocked', fileName: 'x.html', contentType: 'text/html', sizeBytes: 8, dataBase64: Buffer.from('<script>').toString('base64') },
      });
      assert.equal(blocked.status, 415);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
