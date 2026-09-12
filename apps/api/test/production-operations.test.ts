import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import { listSecurityEvents, listSecurityIncidents, observedMalwareScannerHealth, productionReadiness, recordSecurityEvent, resolveSecurityEvent, resolveSecurityIncident, resolveSupplierEmailIdentityIncidentsAfterSuccessfulIngest, resolveSupplierEmailIdentityIncidentsForMailboxSelfSender, securityIncidentSummary, SecurityEventResolutionError } from '../src/production-operations.js';

test('生产监控：汇总过期租约、失败队列、连接器与安全告警', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const tenantId = 'tenant:ops';
  const old = '2026-08-21T00:00:00.000Z';
  db.prepare(`INSERT INTO action_executions
    (tenant_id,idempotency_key,run_id,node_id,status,json,created_at,lease_expires_at,attempt,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(tenantId, 'idem:1', 'run:1', 'node:1', 'pending', '{}', old, old, 1, old);
  db.prepare(`INSERT INTO control_workflow_runs
    (tenant_id,id,employee_id,workflow_id,status,mode,json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(tenantId, 'run:failed', 'ai:p', 'wf:p', 'failed', 'autonomous', '{}', old, old);
  db.prepare(`INSERT INTO control_connector_events
    (tenant_id,connector_id,event_type,status,message,metadata_json,created_at)
    VALUES (?,?,?,?,?,?,?)`).run(tenantId, 'erp', 'execute', 'failed', '连接失败', '{}', '2026-08-21T05:00:00.000Z');
  db.prepare(`INSERT INTO procurement_attachments
    (tenant_id,id,requisition_id,file_name,content_type,size_bytes,sha256,version,extraction_status,content,status,created_by,created_at,security_status)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'active',?,?, 'pending_scan')`).run(
    tenantId, 'attachment:ops', 'requisition:ops', 'ops.txt', 'text/plain', 3, 'a'.repeat(64), 1, 'text_extracted', Buffer.from('ops'), 'human:ops', old,
  );
  recordSecurityEvent(db, {
    tenantId, eventType: 'authorization_denied', severity: 'warning', requestId: 'req:1', method: 'POST',
    path: '/api/editor/credentials?token=must-not-store', actorId: 'h:buyer', message: 'token=secret-value 权限拒绝',
  });

  const result = productionReadiness(db, tenantId, { status: 'unavailable', workerObserved: false, pollerCount: 0 }, [
    { id: 'erp', status: 'installed', runtime: 'local_process', runtimeHealthy: false, externalVerified: false },
  ], new Date('2026-08-21T06:00:00.000Z'), {
    backend: 's3', configured: true, status: 'configured_unverified', integrityVerification: true, encryption: 'AES256',
  }, {
    engine: 'clamd', configured: true, status: 'configured_unverified',
  });
  assert.equal(result['status'], 'critical');
  assert.equal((result['queue'] as Record<string, unknown>)['deadLetter'], 1);
  assert.equal((result['sideEffects'] as Record<string, unknown>)['expiredLeases'], 1);
  assert.equal((result['connectors'] as Record<string, unknown>)['isolated'], 1);
  assert.equal((result['documents'] as Record<string, unknown>)['pendingMalwareScan'], 1);
  assert.equal((result['documents'] as Record<string, unknown>)['externalSendGate'], 'requires-security-status-clean');
  assert.deepEqual((result['documents'] as Record<string, unknown>)['storage'], {
    backend: 's3', configured: true, status: 'configured_unverified', integrityVerification: true, encryption: 'AES256',
  });
  assert.deepEqual((result['documents'] as Record<string, unknown>)['malwareScanner'], {
    engine: 'clamd', configured: true, status: 'configured_unverified',
  });
  assert.ok((result['alerts'] as string[]).length >= 3);

  const events = listSecurityEvents(db, tenantId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!['path'], '/api/editor/credentials');
  assert.equal(String(events[0]!['message']).includes('secret-value'), false);
  db.close();
});

test('生产监控：租户之间不能读取安全事件', () => {
  const db = new DatabaseSync(':memory:');
  recordSecurityEvent(db, { tenantId: 'tenant:a', eventType: 'origin_denied', severity: 'warning', requestId: 'r1', method: 'GET', path: '/api/x', message: '拒绝' });
  recordSecurityEvent(db, { tenantId: 'tenant:b', eventType: 'origin_denied', severity: 'warning', requestId: 'r2', method: 'GET', path: '/api/y', message: '拒绝' });
  assert.deepEqual(listSecurityEvents(db, 'tenant:a').map((event) => event['requestId']), ['r1']);
  assert.deepEqual(listSecurityEvents(db, 'tenant:b').map((event) => event['requestId']), ['r2']);
  db.close();
});

test('生产监控：安全告警处置保留原始事件、版本、审计和幂等重放', () => {
  const db = new DatabaseSync(':memory:');
  const tenantId = 'tenant:ops';
  recordSecurityEvent(db, {
    tenantId, eventType: 'supplier_email_identity_rejected', severity: 'warning', requestId: 'req:identity',
    method: 'IMAP', path: '/api/procurement/inbound-mail', message: '供应商发件身份未通过',
  });
  const original = listSecurityEvents(db, tenantId)[0]!;
  assert.equal((original['resolution'] as Record<string, unknown>)['status'], 'open');
  assert.equal((original['resolution'] as Record<string, unknown>)['version'], 0);

  const accepted = resolveSecurityEvent(db, {
    tenantId, eventSeq: Number(original['seq']), status: 'accepted_risk', reason: '历史验收邮箱已停用，保留证据并接受风险',
    actorId: 'human:admin', expectedVersion: 0,
  }, new Date('2026-08-28T06:00:00.000Z'));
  assert.equal(accepted.replayed, false);
  assert.deepEqual(accepted.item['resolution'], {
    status: 'accepted_risk', reason: '历史验收邮箱已停用，保留证据并接受风险', actorId: 'human:admin', version: 1,
    createdAt: '2026-08-28T06:00:00.000Z', updatedAt: '2026-08-28T06:00:00.000Z',
  });
  const replay = resolveSecurityEvent(db, {
    tenantId, eventSeq: Number(original['seq']), status: 'accepted_risk', reason: '历史验收邮箱已停用，保留证据并接受风险',
    actorId: 'human:admin', expectedVersion: 0,
  }, new Date('2026-08-28T06:01:00.000Z'));
  assert.equal(replay.replayed, true);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM control_security_event_resolution_audit').get() as { count: number }).count), 1);

  assert.throws(() => resolveSecurityEvent(db, {
    tenantId, eventSeq: Number(original['seq']), status: 'resolved', reason: '根因已经修复并完成复测',
    actorId: 'human:other', expectedVersion: 0,
  }), (error: unknown) => error instanceof SecurityEventResolutionError && error.code === 'VERSION_CONFLICT');
  assert.throws(() => resolveSecurityEvent(db, {
    tenantId: 'tenant:other', eventSeq: Number(original['seq']), status: 'resolved', reason: '尝试跨租户处置该事件',
    actorId: 'human:other', expectedVersion: 0,
  }), (error: unknown) => error instanceof SecurityEventResolutionError && error.code === 'NOT_FOUND');

  const readiness = productionReadiness(db, tenantId, { status: 'ready', workerObserved: true, pollerCount: 1 }, [], new Date('2026-08-28T07:00:00.000Z'));
  assert.equal(readiness['status'], 'ready');
  assert.deepEqual(readiness['security'], {
    monitoring: true, warnings24h: 0, openWarnings24h: 0, acceptedRisk24h: 1, resolved24h: 0,
    controls: ['origin-allowlist', 'signed-session', 'role-permissions', 'tenant-isolation', 'signed-webhook', 'redacted-errors'],
  });
  db.close();
});

test('生产监控：重复原始事件按请求身份聚合为事故并原子处置', () => {
  const db = new DatabaseSync(':memory:');
  const tenantId = 'tenant:incident';
  const repeated = {
    tenantId, eventType: 'supplier_email_identity_rejected' as const, severity: 'warning' as const,
    requestId: 'imap:uid-7', method: 'IMAP', path: '/supplier-replies', actorId: 'connector:email',
    message: '供应商回信身份校验失败：SUPPLIER_EMAIL_MISMATCH',
  };
  recordSecurityEvent(db, repeated);
  recordSecurityEvent(db, repeated);
  recordSecurityEvent(db, { ...repeated, requestId: 'imap:uid-8' });
  const at = '2026-08-28T08:00:00.000Z';
  const document = db.prepare(`INSERT INTO procurement_documents
    (tenant_id,kind,id,source_system,external_id,status,version,json,created_at,updated_at)
    VALUES (?,?,?,?,?,'active',1,?,?,?)`);
  document.run(tenantId, 'supplier', 'supplier:real', 'odoo', 'partner:1', JSON.stringify({
    id: 'supplier:real', name: '真实供应商', contacts: [{ email: 'supplier@example.com', primary: true }],
  }), at, at);
  document.run(tenantId, 'purchase_order', 'po:real', 'odoo', 'P00011', JSON.stringify({
    id: 'po:real', number: 'P00011', supplierId: 'supplier:real', status: 'sent',
  }), at, at);
  db.prepare(`INSERT INTO procurement_inbound_mail_rejections
    (tenant_id,provider,mailbox,provider_uid,message_id,observed_sender,po_number,reason_code,attempts,first_seen_at,last_seen_at,next_attempt_at)
    VALUES (?,'imap:imap.example.net','INBOX','uid-7','<reply@example.net>','actual-sender@example.net','P00011','SUPPLIER_EMAIL_MISMATCH',6,?,?,?)`)
    .run(tenantId, at, at, '2026-08-29T08:00:00.000Z');

  const incidents = listSecurityIncidents(db, tenantId);
  assert.equal(incidents.length, 2);
  const incident = incidents.find((item) => item.requestId === 'imap:uid-7')!;
  assert.equal(incident.rawEventCount, 2);
  assert.equal(incident.resolution.status, 'open');
  assert.deepEqual(incident.related, {
    providerUid: 'uid-7', poNumber: 'P00011', reasonCode: 'SUPPLIER_EMAIL_MISMATCH', attempts: 6,
    firstSeenAt: at, lastSeenAt: at, nextAttemptAt: '2026-08-29T08:00:00.000Z',
    supplierId: 'supplier:real', supplierName: '真实供应商', expectedEmails: ['supplier@example.com'],
    observedSender: 'actual-sender@example.net', observedSenderAvailable: true,
  });
  assert.deepEqual(securityIncidentSummary(db, tenantId), { total: 2, open: 2, rawEvents: 3 });

  const resolved = resolveSecurityIncident(db, {
    tenantId, incidentKey: incident.incidentKey, status: 'resolved',
    reason: '供应商主数据邮箱已修复，并完成真实回信复测', actorId: 'human:admin', expectedVersion: incident.version,
  }, new Date('2026-08-28T09:00:00.000Z'));
  assert.equal(resolved.replayed, false);
  assert.equal(resolved.updatedEvents, 2);
  assert.equal(resolved.item.resolution.status, 'resolved');
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM control_security_events WHERE tenant_id=?').get(tenantId) as { count: number }).count), 3);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM control_security_event_resolution_audit WHERE tenant_id=?').get(tenantId) as { count: number }).count), 2);
  assert.deepEqual(securityIncidentSummary(db, tenantId), { total: 2, open: 1, rawEvents: 3 });

  const replay = resolveSecurityIncident(db, {
    tenantId, incidentKey: incident.incidentKey, status: 'resolved',
    reason: '供应商主数据邮箱已修复，并完成真实回信复测', actorId: 'human:admin', expectedVersion: incident.version,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.updatedEvents, 0);
  assert.throws(() => resolveSecurityIncident(db, {
    tenantId: 'tenant:other', incidentKey: incident.incidentKey, status: 'resolved',
    reason: '尝试跨租户处置事故', actorId: 'human:other', expectedVersion: incident.version,
  }), (error: unknown) => error instanceof SecurityEventResolutionError && error.code === 'NOT_FOUND');
  db.close();
});

test('生产监控：同一供应商邮件成功入库后自动追加事故已修复审计', () => {
  const db = new DatabaseSync(':memory:');
  const tenantId = 'tenant:identity-remediated';
  const event = {
    tenantId, eventType: 'supplier_email_identity_rejected' as const, severity: 'warning' as const,
    requestId: 'imap:uid-remediated', method: 'IMAP', path: '/supplier-replies', actorId: 'connector:email',
    message: '供应商回信身份校验失败：SUPPLIER_EMAIL_MISMATCH',
  };
  recordSecurityEvent(db, event);
  recordSecurityEvent(db, event);

  const result = resolveSupplierEmailIdentityIncidentsAfterSuccessfulIngest(
    db, tenantId, 'uid-remediated', new Date('2026-08-30T12:00:00.000Z'),
  );
  assert.deepEqual(result, { incidents: 1, events: 2 });
  const incident = listSecurityIncidents(db, tenantId)[0]!;
  assert.equal(incident.resolution.status, 'resolved');
  assert.equal(incident.resolution.actorId, 'connector:email');
  assert.match(incident.resolution.reason ?? '', /成功写入采购证据链/);
  assert.deepEqual(securityIncidentSummary(db, tenantId), { total: 1, open: 0, rawEvents: 2 });
  assert.equal(resolveSupplierEmailIdentityIncidentsAfterSuccessfulIngest(db, tenantId, 'uid-remediated').events, 0);
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM control_security_event_resolution_audit').get() as { count: number }).count), 2);
  db.close();
});

test('生产监控：采购邮箱自发副本不冒充供应商回复并追加解释审计', () => {
  const db = new DatabaseSync(':memory:');
  const tenantId = 'tenant:self-sender';
  recordSecurityEvent(db, {
    tenantId, eventType: 'supplier_email_identity_rejected', severity: 'warning', requestId: 'imap:uid-self',
    method: 'IMAP', path: '/supplier-replies', actorId: 'connector:email',
    message: '供应商回信身份校验失败：SUPPLIER_EMAIL_MISMATCH',
  });

  assert.deepEqual(resolveSupplierEmailIdentityIncidentsForMailboxSelfSender(db, {
    tenantId, providerUid: 'uid-self', observedSender: '采购员 <Buyer@Example.com>', mailboxAddress: 'buyer@example.com',
  }, new Date('2026-08-30T12:30:00.000Z')), { matched: true, incidents: 1, events: 1 });
  const incident = listSecurityIncidents(db, tenantId)[0]!;
  assert.equal(incident.resolution.status, 'resolved');
  assert.equal(incident.resolution.actorId, 'connector:email');
  assert.match(incident.resolution.reason ?? '', /本方发件副本/);
  assert.deepEqual(resolveSupplierEmailIdentityIncidentsForMailboxSelfSender(db, {
    tenantId, providerUid: 'uid-self', observedSender: 'supplier@example.com', mailboxAddress: 'buyer@example.com',
  }), { matched: false, incidents: 0, events: 0 });
  db.close();
});

test('生产监控：ClamAV 只在真实终态扫描后标记 ready', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  assert.deepEqual(observedMalwareScannerHealth(db, 'tenant:a', 'clamscan', false), {
    engine: 'clamscan', configured: false, status: 'not_observed',
  });
  assert.deepEqual(observedMalwareScannerHealth(db, 'tenant:a', 'clamscan', true), {
    engine: 'clamscan', configured: true, status: 'configured_unverified',
  });
  const insert = db.prepare(`INSERT INTO procurement_attachment_audit
    (tenant_id,id,attachment_id,requisition_id,actor_id,action,detail_json,created_at,owner_type,owner_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  insert.run('tenant:a', 'audit:clean', 'attachment:a', 'requisition:a', 'system:scanner', 'malware_scan_clean', '{}', '2026-08-21T00:00:00.000Z', 'requisition', 'requisition:a');
  assert.deepEqual(observedMalwareScannerHealth(db, 'tenant:a', 'clamscan', true), {
    engine: 'clamscan', configured: true, status: 'ready',
  });
  insert.run('tenant:a', 'audit:failed', 'attachment:b', 'requisition:a', 'system:scanner', 'malware_scan_failed', '{}', '2026-08-22T00:00:00.000Z', 'requisition', 'requisition:a');
  assert.deepEqual(observedMalwareScannerHealth(db, 'tenant:a', 'clamscan', true), {
    engine: 'clamscan', configured: true, status: 'unavailable',
  });
  insert.run('tenant:b', 'audit:other-tenant', 'attachment:c', 'requisition:b', 'system:scanner', 'malware_scan_clean', '{}', '2026-08-23T00:00:00.000Z', 'requisition', 'requisition:b');
  assert.equal(observedMalwareScannerHealth(db, 'tenant:a', 'clamscan', true).status, 'unavailable');
  db.close();
});

test('生产监控：Worker 就绪时仍会因死信或安全告警降级', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  db.prepare(`INSERT INTO control_workflow_runs
    (tenant_id,id,employee_id,workflow_id,status,mode,json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'tenant:ops', 'run:dead-letter', 'ai:procurement', 'wf:procurement', 'failed', 'autonomous', '{}',
    '2026-08-21T05:00:00.000Z', '2026-08-21T05:00:00.000Z',
  );
  recordSecurityEvent(db, {
    tenantId: 'tenant:ops', eventType: 'authorization_denied', severity: 'warning', requestId: 'req:warning',
    method: 'POST', path: '/api/procurement/actions', message: '权限拒绝',
  });
  const result = productionReadiness(
    db,
    'tenant:ops',
    { status: 'ready', workerObserved: true, pollerCount: 1 },
    [],
    new Date(),
  );
  assert.equal(result['status'], 'degraded');
  assert.equal((result['queue'] as Record<string, unknown>)['workerReady'], true);
  assert.equal((result['queue'] as Record<string, unknown>)['deadLetter'], 1);
  assert.ok((result['alerts'] as string[]).some((item) => item.includes('死信')));
  assert.ok((result['alerts'] as string[]).some((item) => item.includes('安全告警')));
  db.close();
});

test('生产监控：历史模拟失败保留审计但不计入生产死信', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  db.prepare(`INSERT INTO control_workflow_runs
    (tenant_id,id,employee_id,workflow_id,status,mode,json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    'tenant:ops', 'run:simulation-failed', 'ai:procurement', 'wf:procurement', 'failed', 'simulate', '{}',
    '2026-08-20T05:00:00.000Z', '2026-08-20T05:00:00.000Z',
  );
  const result = productionReadiness(
    db,
    'tenant:ops',
    { status: 'ready', workerObserved: true, pollerCount: 1 },
    [],
    new Date('2026-08-28T05:00:00.000Z'),
  );
  const queue = result['queue'] as Record<string, unknown>;
  assert.equal(result['status'], 'ready');
  assert.equal(queue['deadLetter'], 0);
  assert.equal(queue['failedSimulations'], 1);
  assert.equal((result['alerts'] as string[]).some((item) => item.includes('死信')), false);
  db.close();
});
