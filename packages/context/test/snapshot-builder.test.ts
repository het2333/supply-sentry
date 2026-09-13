import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type {
  AppendTwinAgentEventInput,
  AppendTwinEvidenceInput,
  TwinAccessScope,
  TwinEntity,
  TwinEvidence,
  TwinNeighborhood,
  TwinRelation,
} from '@readywork/core';
import { initializeControlPlaneSchema } from '@readywork/persistence';
import * as contextModule from '../src/index.js';
import { SqliteManufacturingContextStore } from '../src/sqlite-manufacturing-context-store.js';

const at = '2026-08-29T00:00:00.000Z';

const fullReference = (primaryKey: string, sourceVersion = '1') => ({
  table: 'procurement_documents',
  primaryKey,
  sourceVersion,
  contentHash: `hash:${primaryKey}:${sourceVersion}`,
});

const readScope: TwinAccessScope = {
  permission: 'read',
  entityTypes: ['purchase_order', 'supplier', 'contact', 'communication'],
  includeContactDetails: false,
  includeCommercialTerms: false,
};

function contextFixture(includeLongCredentialNote = false) {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const store = new SqliteManufacturingContextStore(db, 'tenant:a');
  const po = store.upsertEntity({
    entityType: 'purchase_order', canonicalKey: 'readywork:po:1', label: 'PO-1', lifecycleState: 'sent',
    attributes: { businessObjectId: 'po:1', commercialTerm: 'NET30', unitPrice: 127, currency: 'CNY' },
    state: { missingFacts: ['supplier_confirmation'] }, sourceWatermark: 'w1', effectiveAt: at, observedAt: at,
  });
  const supplier = store.upsertEntity({
    entityType: 'supplier', canonicalKey: 'odoo:partner:6', label: '上海卓越阀门', lifecycleState: 'active',
    attributes: {
      contacts: [{ email: 'supplier@supplysentry.invalid', phone: '13800138000' }],
      EMAIL_ADDRESS: 'upper@example.com',
      contactEmail: ['array@example.com', { address: 'nested@example.com', label: 'work' }],
      emails: ['one@example.com', 'two@example.com'],
      Phone_Numbers: ['13900139000', { number: '13700137000', label: 'office' }],
      nested: { cookieJar: { value: 'secret-cookie' }, safe: 'kept' },
      ...(includeLongCredentialNote ? { longNote: `authorization=inline-secret ${'x'.repeat(20_050)} END` } : {}),
      emailMessage: { sourceObjectId: 'mail:1', contentHash: 'hash:mail:1', subject: 'PO update', rawBody: 'RAW EMAIL BODY' },
      attachment: { sourceObjectId: 'attachment:1', contentHash: 'hash:attachment:1', fileName: 'po.pdf', bytes: 'RAW ATTACHMENT BYTES' },
      emailPacket: {
        sourceObjectId: 'authorization=mail-reference-secret', contentHash: 'token=mail-reference-secret',
        subject: 'Case variants', 'RAW-EMAIL-BODY': 'CASE RAW BODY',
      },
      attachmentRecord: {
        sourceObjectId: 'authorization=attachment-reference-secret', contentHash: 'token=attachment-reference-secret',
        fileName: 'case.bin', CONTENT_BYTES: 'CASE ATTACHMENT BYTES',
      },
    },
    state: {}, sourceWatermark: 'w1', effectiveAt: at, observedAt: at,
  });
  const statusEvidence = store.appendEvidence({
    entityId: po.id, sourceSemantics: 'verified_external', sourceKind: 'outbox', sourceId: 'outbox:1',
    sourceVersion: '1', sourceHash: 'hash:sent', factPath: 'purchase_order.status', value: 'sent',
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'connector:email',
    rawReference: fullReference('purchase_order:po:1'),
  });
  store.upsertRelation({
    relationType: 'ordered_from', fromEntityId: po.id, toEntityId: supplier.id, status: 'active',
    sourceEvidenceId: statusEvidence.id, validFrom: at,
  });
  const legacyEvidence = store.appendEvidence({
    entityId: supplier.id, sourceSemantics: 'deterministic', sourceKind: 'legacy_table', sourceId: 'legacy:source:1',
    sourceVersion: 'legacy-v3', sourceHash: 'legacy-content-hash', factPath: 'supplier.reference', value: 'legacy',
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'system:legacy',
    rawReference: { table: 'legacy_table', extra: 'authorization=must-drop' },
  });
  return { db, store, po, supplier, legacyEvidence };
}

function externalStatusEvidence(entityId: string, value: string, sourceVersion: string): AppendTwinEvidenceInput {
  return {
    entityId, sourceSemantics: 'verified_external', sourceKind: 'odoo', sourceId: 'purchase.order:1',
    sourceVersion, sourceHash: `hash:${value}:${sourceVersion}`, factPath: 'purchase_order.status', value,
    confidence: 1, effectiveAt: at, observedAt: at, actorId: 'source:odoo',
    rawReference: fullReference('purchase_order:po:1', sourceVersion),
  };
}

function snapshotEntities(snapshot: Record<string, unknown>): Array<Record<string, any>> {
  return snapshot['entities'] as Array<Record<string, any>>;
}

function graphEntity(id: string, entityType: TwinEntity['entityType']): TwinEntity {
  return {
    tenantId: 'tenant:closure', id, entityType, canonicalKey: id, label: id, lifecycleState: 'active',
    attributes: {}, state: {}, currentRevision: 1, sourceWatermark: 'w', effectiveAt: at, observedAt: at,
    createdAt: at, updatedAt: at,
  };
}

function graphEvidence(
  id: string,
  entityId: string,
  options: { relationId?: string; supersedesEvidenceId?: string } = {},
): TwinEvidence {
  return {
    tenantId: 'tenant:closure', id, entityId, ...options, sourceSemantics: 'verified_external',
    sourceKind: 'test', sourceId: id, sourceVersion: '1', sourceHash: `hash:${id}`,
    factPath: `test.${id}`, value: id, priority: 400, confidence: 1, effectiveAt: at, observedAt: at,
    actorId: 'test', rawReference: fullReference(id), createdAt: at,
  };
}

function graphRelation(
  id: string,
  fromEntityId: string,
  toEntityId: string,
  sourceEvidenceId: string,
): TwinRelation {
  return {
    tenantId: 'tenant:closure', id, relationType: 'test_link', fromEntityId, toEntityId,
    status: 'active', sourceEvidenceId, validFrom: at, createdAt: at, updatedAt: at,
  };
}

test('scopeForSession maps commercial terms and projection health to the exact permission policy', () => {
  const exported = contextModule as unknown as {
    scopeForSession?: (
      permission: TwinAccessScope['permission'],
      options?: { entityTypes?: TwinAccessScope['entityTypes']; requiresCommercialTerms?: boolean; purpose?: string },
    ) => TwinAccessScope & { includeProjectionHealth?: boolean };
  };
  assert.equal(typeof exported.scopeForSession, 'function');
  const scopeForSession = exported.scopeForSession!;
  assert.deepEqual(scopeForSession('read'), {
    permission: 'read', entityTypes: [], includeContactDetails: false,
    includeCommercialTerms: false, includeProjectionHealth: false,
  });
  assert.equal(scopeForSession('operate').includeContactDetails, true);
  assert.equal(scopeForSession('operate').includeCommercialTerms, false);
  assert.equal(scopeForSession('operate', { requiresCommercialTerms: true }).includeCommercialTerms, false);
  assert.equal(scopeForSession('operate', { purpose: 'po_supplier_commitment' }).includeCommercialTerms, true);
  assert.equal(scopeForSession('operate', { purpose: 'quote_comparison' }).includeCommercialTerms, true);
  assert.equal(scopeForSession('operate', { purpose: 'read-bypass', requiresCommercialTerms: true }).includeCommercialTerms, false);
  assert.equal(scopeForSession('approve').includeCommercialTerms, true);
  assert.equal(scopeForSession('approve').includeProjectionHealth, false);
  assert.equal(scopeForSession('configure').includeProjectionHealth, true);
  assert.equal(scopeForSession('admin').includeProjectionHealth, true);
});

test('snapshot deterministically masks contact fields, drops deep credentials, and replaces restricted content', () => {
  const fixture = contextFixture(true);
  try {
    const created = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id, purpose: 'po_supplier_commitment', scope: readScope,
    });
    const supplier = snapshotEntities(created.snapshot).find((entity) => entity['entityType'] === 'supplier')!;
    const attributes = supplier['attributes'] as Record<string, any>;
    assert.equal(attributes['contacts'][0].email, 's***@supplysentry.invalid');
    assert.equal(attributes['contacts'][0].phone, '138****8000');
    assert.equal(attributes['EMAIL_ADDRESS'], 'u***@example.com');
    assert.deepEqual(attributes['contactEmail'], [
      'a***@example.com', { address: 'n***@example.com', label: 'work' },
    ]);
    assert.deepEqual(attributes['emails'], ['o***@example.com', 't***@example.com']);
    assert.deepEqual(attributes['Phone_Numbers'], [
      '139****9000', { number: '137****7000', label: 'office' },
    ]);
    assert.deepEqual(attributes['nested'], { safe: 'kept' });
    assert.match(attributes['longNote'], /authorization=\[REDACTED\]/);
    assert.match(attributes['longNote'], / END$/);
    assert.equal(attributes['emailMessage'].subject, 'PO update');
    assert.deepEqual(attributes['emailMessage'].rawBody, {
      contentHash: 'hash:mail:1', restricted: true, sourceObjectId: 'mail:1',
    });
    assert.equal(attributes['attachment'].fileName, 'po.pdf');
    assert.deepEqual(attributes['attachment'].bytes, {
      contentHash: 'hash:attachment:1', restricted: true, sourceObjectId: 'attachment:1',
    });
    assert.equal(attributes['emailPacket'].subject, 'Case variants');
    assert.equal(attributes['emailPacket']['RAW-EMAIL-BODY'].restricted, true);
    assert.doesNotMatch(JSON.stringify(attributes['emailPacket']['RAW-EMAIL-BODY']), /mail-reference-secret/);
    assert.equal(attributes['attachmentRecord'].fileName, 'case.bin');
    assert.equal(attributes['attachmentRecord'].CONTENT_BYTES.restricted, true);
    assert.doesNotMatch(JSON.stringify(attributes['attachmentRecord'].CONTENT_BYTES), /attachment-reference-secret/);
    const rawReference = (created.snapshot['evidence'] as Array<Record<string, any>>)[0]!['rawReference'];
    assert.deepEqual(Object.keys(rawReference).sort(), ['contentHash', 'primaryKey', 'sourceVersion', 'table']);
    const legacyReference = (created.snapshot['evidence'] as Array<Record<string, any>>)
      .find((item) => item['id'] === fixture.legacyEvidence.id)!['rawReference'];
    assert.deepEqual(legacyReference, {
      contentHash: 'legacy-content-hash', primaryKey: 'legacy:source:1',
      sourceVersion: 'legacy-v3', table: 'legacy_table',
    });
    assert.doesNotMatch(JSON.stringify(created.snapshot), /secret-cookie|RAW EMAIL BODY|RAW ATTACHMENT BYTES/);
  } finally {
    fixture.db.close();
  }
});

test('field policy matches explicit aliases without stripping benign substring keys', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const store = new SqliteManufacturingContextStore(db, 'tenant:classification');
  try {
    const root = store.upsertEntity({
      entityType: 'purchase_order', canonicalKey: 'po:classification', label: 'PO classification', lifecycleState: 'draft',
      attributes: {
        nested: {
          generatedAt: at,
          corporateName: 'Example Manufacturing',
          tokenCount: 42,
          secretariat: 'board office',
          clientSecret: 'drop-client-secret',
          API_KEY: 'drop-api-key',
          access_token: 'drop-access-token',
          paymentTerms: 'NET30',
          UNIT_PRICE: 17,
          email_address: ['buyer@example.com', { address: 'owner@example.com', label: 'owner' }],
          emailMessage: {
            sourceObjectId: 'mail:classification', contentHash: 'hash:mail:classification',
            subject: 'safe subject', raw_email_body: 'PRIVATE EMAIL BODY',
          },
        },
      },
      state: { missingFacts: [] }, sourceWatermark: 'w', effectiveAt: at, observedAt: at,
    });
    const factPaths = [
      'purchase_order.generatedAt',
      'purchase_order.corporateName',
      'purchase_order.tokenCount',
      'purchase_order.secretariat',
      'purchase_order.clientSecret',
      'purchase_order.api_key',
      'purchase_order.accessToken',
      'purchase_order.paymentTerms',
      'purchase_order.unit_price',
    ];
    for (const factPath of factPaths) {
      store.appendEvidence({
        entityId: root.id, sourceSemantics: 'verified_external', sourceKind: 'test', sourceId: factPath,
        sourceVersion: '1', sourceHash: `hash:${factPath}`, factPath, value: `value:${factPath}`,
        confidence: 1, effectiveAt: at, observedAt: at, actorId: 'test', rawReference: fullReference(factPath),
      });
    }

    const created = store.createSnapshot({
      employeeId: 'ai:classification', rootEntityId: root.id, purpose: 'read',
      scope: { ...readScope, entityTypes: ['purchase_order'] },
    });
    const nested = (created.snapshot['root'] as Record<string, any>)['attributes']['nested'] as Record<string, any>;
    assert.equal(nested['generatedAt'], at);
    assert.equal(nested['corporateName'], 'Example Manufacturing');
    assert.equal(nested['tokenCount'], 42);
    assert.equal(nested['secretariat'], 'board office');
    assert.equal('clientSecret' in nested, false);
    assert.equal('API_KEY' in nested, false);
    assert.equal('access_token' in nested, false);
    assert.equal('paymentTerms' in nested, false);
    assert.equal('UNIT_PRICE' in nested, false);
    assert.deepEqual(nested['email_address'], [
      'b***@example.com', { address: 'o***@example.com', label: 'owner' },
    ]);
    assert.equal(nested['emailMessage'].subject, 'safe subject');
    assert.deepEqual(nested['emailMessage']['raw_email_body'], {
      contentHash: 'hash:mail:classification', restricted: true, sourceObjectId: 'mail:classification',
    });
    const retainedFactPaths = new Set((created.snapshot['evidence'] as Array<Record<string, unknown>>)
      .map((item) => item['factPath']));
    assert.deepEqual([...retainedFactPaths].sort(), [
      'purchase_order.corporateName',
      'purchase_order.generatedAt',
      'purchase_order.secretariat',
      'purchase_order.tokenCount',
    ]);
  } finally {
    db.close();
  }
});

test('snapshot replaces raw content inside exact plural restricted containers without overmatching benign keys', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const store = new SqliteManufacturingContextStore(db, 'tenant:plural-snapshot');
  try {
    const root = store.upsertEntity({
      entityType: 'purchase_order', canonicalKey: 'po:plural-snapshot', label: 'PO plural snapshot', lifecycleState: 'draft',
      attributes: {
        attachments: [{ id: 'attachment:plural', content: 'SNAPSHOT_ATTACHMENT_PRIVATE', fileName: 'safe.pdf' }],
        emails: [{ id: 'email:plural', body: 'SNAPSHOT_EMAIL_PRIVATE', subject: 'safe email subject' }],
        messages: [
          { id: 'message:raw-body', rawBody: 'SNAPSHOT_MESSAGE_RAW_BODY_PRIVATE', subject: 'safe raw subject' },
          { id: 'message:body', body: 'SNAPSHOT_MESSAGE_BODY_PRIVATE', subject: 'safe body subject' },
          { id: 'message:content', content: 'SNAPSHOT_MESSAGE_CONTENT_PRIVATE', subject: 'safe content subject' },
        ],
        files: [{ id: 'file:plural', content: 'SNAPSHOT_FILE_PRIVATE', fileName: 'safe.bin' }],
        documents: [{ id: 'document:plural', content: 'SNAPSHOT_DOCUMENT_PRIVATE', documentType: 'invoice' }],
        benign: {
          attachmentCount: 1, messageCount: 2, emailCount: 3,
          fileName: 'visible-name.pdf', documentType: 'visible-type',
        },
      },
      state: { missingFacts: [] }, sourceWatermark: 'w', effectiveAt: at, observedAt: at,
    });
    const created = store.createSnapshot({
      employeeId: 'ai:plural-snapshot', rootEntityId: root.id, purpose: 'read',
      scope: { ...readScope, entityTypes: ['purchase_order'] },
    });
    const attributes = (created.snapshot['root'] as Record<string, any>)['attributes'] as Record<string, any>;
    const rawBodyMessage = attributes['messages'].find((item: Record<string, unknown>) => 'rawBody' in item)!;
    const bodyMessage = attributes['messages'].find((item: Record<string, unknown>) => 'body' in item)!;
    const contentMessage = attributes['messages'].find((item: Record<string, unknown>) => 'content' in item)!;
    const restrictedReferences = [
      attributes['attachments'][0]['content'],
      attributes['emails'][0]['body'],
      rawBodyMessage['rawBody'],
      bodyMessage['body'],
      contentMessage['content'],
      attributes['files'][0]['content'],
      attributes['documents'][0]['content'],
    ];
    for (const reference of restrictedReferences) {
      assert.equal(reference['restricted'], true);
      assert.deepEqual(Object.keys(reference).sort(), ['contentHash', 'restricted', 'sourceObjectId']);
    }
    assert.equal(attributes['attachments'][0]['fileName'], 'safe.pdf');
    assert.equal(attributes['emails'][0]['subject'], 'safe email subject');
    assert.equal(contentMessage['subject'], 'safe content subject');
    assert.equal(attributes['files'][0]['fileName'], 'safe.bin');
    assert.equal(attributes['documents'][0]['documentType'], 'invoice');
    assert.deepEqual(attributes['benign'], {
      attachmentCount: 1, documentType: 'visible-type', emailCount: 3,
      fileName: 'visible-name.pdf', messageCount: 2,
    });
    assert.doesNotMatch(JSON.stringify(created.snapshot), /SNAPSHOT_(?:ATTACHMENT|EMAIL|MESSAGE|FILE|DOCUMENT).*PRIVATE/);
  } finally {
    db.close();
  }
});

test('snapshot applies commercial-term permissions without dropping the root', () => {
  const fixture = contextFixture();
  try {
    const hidden = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id, purpose: 'read', scope: readScope,
    });
    const approved = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id, purpose: 'approve',
      scope: { ...readScope, permission: 'approve', includeContactDetails: true, includeCommercialTerms: true },
    });
    const attemptedBypass = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id, purpose: 'read-bypass',
      scope: { ...readScope, includeContactDetails: true, includeCommercialTerms: true },
    });
    const operateBypass = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id, purpose: 'read-bypass',
      scope: { ...readScope, permission: 'operate', includeContactDetails: true, includeCommercialTerms: true },
    });
    const trustedCommercialAction = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id, purpose: 'po_supplier_commitment',
      scope: { ...readScope, permission: 'operate', includeContactDetails: false, includeCommercialTerms: false },
    });
    assert.equal((hidden.snapshot['root'] as Record<string, any>)['id'], fixture.po.id);
    assert.equal('commercialTerm' in (hidden.snapshot['root'] as Record<string, any>)['attributes'], false);
    assert.equal('unitPrice' in (hidden.snapshot['root'] as Record<string, any>)['attributes'], false);
    assert.equal((approved.snapshot['root'] as Record<string, any>)['attributes']['commercialTerm'], 'NET30');
    assert.equal((approved.snapshot['root'] as Record<string, any>)['attributes']['unitPrice'], 127);
    assert.equal('commercialTerm' in (attemptedBypass.snapshot['root'] as Record<string, any>)['attributes'], false);
    const bypassSupplier = snapshotEntities(attemptedBypass.snapshot).find((entity) => entity['entityType'] === 'supplier')!;
    assert.equal(bypassSupplier['attributes']['contacts'][0].email, 's***@supplysentry.invalid');
    assert.equal('commercialTerm' in (operateBypass.snapshot['root'] as Record<string, any>)['attributes'], false);
    assert.equal((trustedCommercialAction.snapshot['root'] as Record<string, any>)['attributes']['commercialTerm'], 'NET30');
    const trustedSupplier = snapshotEntities(trustedCommercialAction.snapshot)
      .find((entity) => entity['entityType'] === 'supplier')!;
    assert.equal(trustedSupplier['attributes']['contacts'][0].email, 'supplier@supplysentry.invalid');
    assert.equal(attemptedBypass.contentHash, hidden.contentHash);
    assert.equal(attemptedBypass.permissionFingerprint, hidden.permissionFingerprint);
    assert.equal('projectionHealth' in hidden.snapshot, false);
    assert.deepEqual(hidden.snapshot['missingFacts'], ['supplier_confirmation']);
  } finally {
    fixture.db.close();
  }
});

test('snapshot reload is immutable after new source evidence', () => {
  const fixture = contextFixture();
  try {
    const first = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id,
      purpose: 'po_supplier_commitment', scope: readScope,
    });
    fixture.store.appendEvidence(externalStatusEvidence(fixture.po.id, 'confirmed', 'v2'));
    const second = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id,
      purpose: 'po_supplier_commitment', scope: readScope,
    });
    const loaded = fixture.store.getSnapshot(first.id)!;
    assert.equal(loaded.contentHash, first.contentHash);
    assert.notEqual(second.contentHash, first.contentHash);
    const rootFacts = (loaded.snapshot['root'] as Record<string, any>)['facts'] as Record<string, Record<string, unknown>>;
    assert.equal(rootFacts['purchase_order.status']!['value'], 'sent');
  } finally {
    fixture.db.close();
  }
});

function orderedFixture(reverse: boolean) {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const store = new SqliteManufacturingContextStore(db, 'tenant:stable');
  const root = store.upsertEntity({
    entityType: 'purchase_order', canonicalKey: 'po:stable', label: 'PO stable', lifecycleState: 'sent',
    attributes: reverse ? { z: 2, a: 1 } : { a: 1, z: 2 }, state: { missingFacts: [] },
    sourceWatermark: 'w', effectiveAt: at, observedAt: at,
  });
  const inputs = [
    { key: 'supplier:a', label: 'A', tags: ['red', 'blue'] },
    { key: 'supplier:b', label: 'B', tags: ['green', 'amber'] },
  ];
  if (reverse) inputs.reverse();
  for (const input of inputs) {
    const supplier = store.upsertEntity({
      entityType: 'supplier', canonicalKey: input.key, label: input.label, lifecycleState: 'active',
      attributes: { tags: reverse ? [...input.tags].reverse() : input.tags }, state: {},
      sourceWatermark: 'w', effectiveAt: at, observedAt: at,
    });
    store.upsertRelation({ relationType: 'ordered_from', fromEntityId: root.id, toEntityId: supplier.id,
      status: 'active', sourceEvidenceId: `source:${input.key}`, validFrom: at });
  }
  return { db, store, root };
}

test('snapshot content hash is canonical across insertion, object-key, and array order and excludes snapshot metadata', () => {
  const first = orderedFixture(false);
  const second = orderedFixture(true);
  try {
    const left = first.store.createSnapshot({ employeeId: 'ai:po', rootEntityId: first.root.id, purpose: 'stable', scope: readScope });
    const right = second.store.createSnapshot({ employeeId: 'ai:po', rootEntityId: second.root.id, purpose: 'stable', scope: readScope });
    assert.equal(left.contentHash, right.contentHash);
    assert.equal('id' in left.snapshot, false);
    assert.equal('createdAt' in left.snapshot, false);
    assert.equal(first.store.createSnapshot({ employeeId: 'ai:po', rootEntityId: first.root.id, purpose: 'stable', scope: readScope }).contentHash, left.contentHash);
  } finally {
    first.db.close();
    second.db.close();
  }
});

test('snapshot enforces the exact UTF-8 byte cap by dropping evidence before non-root entities with cursors', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const store = new SqliteManufacturingContextStore(db, 'tenant:size');
  try {
    const root = store.upsertEntity({
      entityType: 'purchase_order', canonicalKey: 'po:size', label: 'PO size', lifecycleState: 'sent',
      attributes: {}, state: { missingFacts: ['grn'] }, sourceWatermark: 'w', effectiveAt: at, observedAt: at,
    });
    for (const key of ['supplier:a', 'supplier:b']) {
      const supplier = store.upsertEntity({
        entityType: 'supplier', canonicalKey: key, label: key, lifecycleState: 'active',
        attributes: { large: key.at(-1)!.repeat(270_000) }, state: {}, sourceWatermark: 'w', effectiveAt: at, observedAt: at,
      });
      store.upsertRelation({ relationType: 'ordered_from', fromEntityId: root.id, toEntityId: supplier.id,
        status: 'active', sourceEvidenceId: `source:${key}`, validFrom: at });
    }
    store.appendEvidence({
      entityId: root.id, sourceSemantics: 'verified_external', sourceKind: 'odoo', sourceId: 'po:size',
      sourceVersion: '1', sourceHash: 'hash:size', factPath: 'purchase_order.large', value: 'e'.repeat(300_000),
      confidence: 1, effectiveAt: at, observedAt: at, actorId: 'source:odoo', rawReference: fullReference('purchase_order:po:size'),
    });
    store.appendEvidence({
      entityId: root.id, sourceSemantics: 'model_derived', sourceKind: 'model', sourceId: 'run:size',
      sourceVersion: '1', sourceHash: 'hash:model:size', factPath: 'purchase_order.large', value: 'conflict',
      confidence: 0.8, effectiveAt: at, observedAt: at, actorId: 'ai:size', rawReference: fullReference('model:run:size'),
    });
    const created = store.createSnapshot({ employeeId: 'ai:size', rootEntityId: root.id, purpose: 'size', scope: readScope });
    const bytes = Buffer.byteLength(JSON.stringify(created.snapshot), 'utf8');
    assert.ok(bytes <= 512 * 1024, `snapshot was ${bytes} bytes`);
    assert.equal(created.snapshot['truncated'], true);
    assert.equal((created.snapshot['root'] as Record<string, unknown>)['id'], root.id);
    assert.deepEqual(created.snapshot['missingFacts'], ['grn']);
    assert.equal((created.snapshot['evidence'] as unknown[]).length, 0);
    assert.equal((created.snapshot['conflicts'] as unknown[]).length, 0);
    assert.equal(snapshotEntities(created.snapshot).filter((entity) => entity['id'] !== root.id).length, 1);
    assert.equal(typeof (created.snapshot['cursors'] as Record<string, unknown>)['evidence'], 'string');
    assert.equal(typeof (created.snapshot['cursors'] as Record<string, unknown>)['entities'], 'string');
  } finally {
    db.close();
  }
});

const allowedEventTypes = [
  'context_read', 'extraction', 'decision', 'recommendation',
  'action_requested', 'action_result', 'human_feedback', 'business_outcome',
] as const;

function eventInput(overrides: Partial<AppendTwinAgentEventInput> = {}): AppendTwinAgentEventInput {
  return {
    employeeId: 'ai:po', runId: 'run:1', taskId: 'task:1', eventType: 'decision', status: 'completed',
    promptHash: 'prompt:1', responseHash: 'response:1', actionName: 'review', evidenceIds: [],
    payload: { outcome: 'continue' }, createdAt: at, ...overrides,
  };
}

test('Agent Events accept only the frozen event types and remain append-only', () => {
  const fixture = contextFixture();
  try {
    for (const eventType of allowedEventTypes) {
      fixture.store.appendAgentEvent(eventInput({ eventType, taskId: `task:${eventType}`, entityId: fixture.po.id }));
    }
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM twin_agent_events WHERE tenant_id=?').get('tenant:a')?.['count'], 8);
    assert.throws(() => fixture.store.appendAgentEvent(eventInput({ eventType: 'tool_trace' as never })), /event type|eventType|事件类型/i);
    const event = fixture.store.appendAgentEvent(eventInput({ taskId: 'task:immutable', entityId: fixture.po.id }));
    assert.throws(() => fixture.db.prepare('UPDATE twin_agent_events SET status=? WHERE tenant_id=? AND id=?')
      .run('changed', 'tenant:a', event.id), /append-only|immutable/i);
    assert.throws(() => fixture.db.prepare('DELETE FROM twin_agent_events WHERE tenant_id=? AND id=?')
      .run('tenant:a', event.id), /append-only|immutable/i);
  } finally {
    fixture.db.close();
  }
});

test('Agent Events validate tenant and snapshot employee ownership without disclosing foreign snapshots', () => {
  const fixture = contextFixture();
  try {
    const snapshot = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id, purpose: 'owned', scope: readScope,
    });
    const tenantB = new SqliteManufacturingContextStore(fixture.db, 'tenant:b');
    let foreignMessage = '';
    let ownerMessage = '';
    assert.throws(() => tenantB.appendAgentEvent(eventInput({ inputSnapshotId: snapshot.id })), (error: unknown) => {
      foreignMessage = error instanceof Error ? error.message : String(error);
      return true;
    });
    assert.throws(() => fixture.store.appendAgentEvent(eventInput({ employeeId: 'ai:other', inputSnapshotId: snapshot.id })), (error: unknown) => {
      ownerMessage = error instanceof Error ? error.message : String(error);
      return true;
    });
    assert.equal(foreignMessage, ownerMessage);
    assert.doesNotMatch(foreignMessage, /tenant:a|ai:po/);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM twin_agent_events').get()?.['count'], 0);
  } finally {
    fixture.db.close();
  }
});

test('Agent Event payloads are deeply redacted and idempotent on the frozen six-field tuple', () => {
  const fixture = contextFixture();
  try {
    const first = fixture.store.appendAgentEvent(eventInput({
      entityId: fixture.po.id,
      payload: {
        nested: { authorization: 'Bearer raw-secret', safe: 'kept' },
        email: { sourceObjectId: 'mail:event', contentHash: 'hash:mail:event', subject: 'Safe subject', rawBody: 'PRIVATE BODY' },
        attachment: { sourceObjectId: 'attachment:event', contentHash: 'hash:attachment:event', fileName: 'safe.pdf', content: 'PRIVATE BYTES' },
      },
    }));
    const replay = fixture.store.appendAgentEvent(eventInput({
      entityId: fixture.po.id, status: 'failed', payload: { changed: true }, createdAt: '2026-08-29T00:01:00.000Z',
    }));
    const distinct = fixture.store.appendAgentEvent(eventInput({ entityId: fixture.po.id, actionName: 'approve' }));
    assert.equal(replay.id, first.id);
    assert.equal(replay.status, 'completed');
    assert.deepEqual(replay.payload, first.payload);
    assert.notEqual(distinct.id, first.id);
    assert.deepEqual((first.payload['nested'] as Record<string, unknown>), { safe: 'kept' });
    assert.deepEqual((first.payload['email'] as Record<string, unknown>)['rawBody'], { contentHash: 'hash:mail:event', restricted: true, sourceObjectId: 'mail:event' });
    assert.equal((first.payload['email'] as Record<string, unknown>)['subject'], 'Safe subject');
    assert.deepEqual((first.payload['attachment'] as Record<string, unknown>)['content'], { contentHash: 'hash:attachment:event', restricted: true, sourceObjectId: 'attachment:event' });
    assert.equal((first.payload['attachment'] as Record<string, unknown>)['fileName'], 'safe.pdf');
    assert.doesNotMatch(JSON.stringify(first.payload), /raw-secret|PRIVATE BODY|PRIVATE BYTES/);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM twin_agent_events WHERE tenant_id=?').get('tenant:a')?.['count'], 2);
  } finally {
    fixture.db.close();
  }
});

test('Agent Event payloads replace raw content inside plural restricted containers and preserve benign keys', () => {
  const fixture = contextFixture();
  try {
    const event = fixture.store.appendAgentEvent(eventInput({
      entityId: fixture.po.id,
      taskId: 'task:plural-containers',
      payload: {
        attachments: [{ content: 'EVENT_ATTACHMENT_PRIVATE', fileName: 'event.pdf' }],
        emails: [{ body: 'EVENT_EMAIL_PRIVATE', subject: 'safe email' }],
        messages: [
          { rawBody: 'EVENT_MESSAGE_RAW_BODY_PRIVATE' },
          { body: 'EVENT_MESSAGE_BODY_PRIVATE' },
          { content: 'EVENT_MESSAGE_CONTENT_PRIVATE' },
        ],
        files: [{ content: 'EVENT_FILE_PRIVATE', fileName: 'event.bin' }],
        documents: [{ content: 'EVENT_DOCUMENT_PRIVATE', documentType: 'receipt' }],
        benign: {
          attachmentCount: 4, messageCount: 5, emailCount: 6,
          fileName: 'event-visible.pdf', documentType: 'event-visible-type',
        },
      },
    }));
    const payload = event.payload as Record<string, any>;
    const restrictedReferences = [
      payload['attachments'][0]['content'],
      payload['emails'][0]['body'],
      payload['messages'][0]['rawBody'],
      payload['messages'][1]['body'],
      payload['messages'][2]['content'],
      payload['files'][0]['content'],
      payload['documents'][0]['content'],
    ];
    for (const reference of restrictedReferences) assert.equal(reference['restricted'], true);
    assert.equal(payload['attachments'][0]['fileName'], 'event.pdf');
    assert.equal(payload['emails'][0]['subject'], 'safe email');
    assert.equal(payload['files'][0]['fileName'], 'event.bin');
    assert.equal(payload['documents'][0]['documentType'], 'receipt');
    assert.deepEqual(payload['benign'], {
      attachmentCount: 4, documentType: 'event-visible-type', emailCount: 6,
      fileName: 'event-visible.pdf', messageCount: 5,
    });
    assert.doesNotMatch(JSON.stringify(event), /EVENT_(?:ATTACHMENT|EMAIL|MESSAGE|FILE|DOCUMENT).*PRIVATE/);
  } finally {
    fixture.db.close();
  }
});

test('sanitization rejects every unsupported JSON shape before getters or native serialization run', () => {
  const fixture = contextFixture();
  try {
    let getterInvoked = false;
    const getterPayload: Record<string, unknown> = {};
    Object.defineProperty(getterPayload, 'trap', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 'must-not-run';
      },
    });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    class UnsupportedPayload { readonly value = 'class-instance'; }
    const cases: Array<readonly [string, unknown]> = [
      ['date', new Date(at)],
      ['map', new Map([['key', 'value']])],
      ['class', new UnsupportedPayload()],
      ['getter', getterPayload],
      ['circular', circular],
      ['bigint', { value: 1n }],
      ['undefined', { value: undefined }],
      ['function', { value: () => 'invalid' }],
      ['symbol', { value: Symbol('invalid') }],
    ];
    for (const [name, payload] of cases) {
      assert.throws(
        () => fixture.store.appendAgentEvent(eventInput({
          taskId: `task:invalid:${name}`, payload: payload as Record<string, unknown>,
        })),
        (error: unknown) => error instanceof Error && error.message === 'Twin JSON 值无效',
      );
    }
    assert.equal(getterInvoked, false);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM twin_agent_events').get()?.['count'], 0);
  } finally {
    fixture.db.close();
  }
});

test('idempotent Agent Event replays validate unsupported payload and status before returning the stored row', () => {
  const fixture = contextFixture();
  try {
    const first = fixture.store.appendAgentEvent(eventInput({
      entityId: fixture.po.id, payload: { original: 'immutable' }, status: 'completed',
    }));
    const storedBefore = fixture.db.prepare(`SELECT status, payload_json FROM twin_agent_events
      WHERE tenant_id=? AND id=?`).get('tenant:a', first.id) as Record<string, unknown>;
    let getterInvoked = false;
    const getterPayload: Record<string, unknown> = {};
    Object.defineProperty(getterPayload, 'trap', {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 'must-not-run';
      },
    });
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const unsupported: Array<readonly [string, unknown]> = [
      ['date', new Date(at)],
      ['map', new Map([['key', 'value']])],
      ['getter', getterPayload],
      ['circular', circular],
      ['bigint', { value: 1n }],
      ['undefined', { value: undefined }],
      ['function', { value: () => 'invalid' }],
      ['symbol', { value: Symbol('invalid') }],
    ];
    for (const [name, payload] of unsupported) {
      assert.throws(
        () => fixture.store.appendAgentEvent(eventInput({
          entityId: fixture.po.id, payload: payload as Record<string, unknown>, status: `replay:${name}`,
        })),
        (error: unknown) => error instanceof Error && error.message === 'Twin JSON 值无效',
      );
      assert.deepEqual(
        fixture.db.prepare(`SELECT status, payload_json FROM twin_agent_events
          WHERE tenant_id=? AND id=?`).get('tenant:a', first.id),
        storedBefore,
      );
    }
    assert.throws(
      () => fixture.store.appendAgentEvent(eventInput({
        entityId: fixture.po.id, payload: { valid: true }, status: new Date(at) as unknown as string,
      })),
      (error: unknown) => error instanceof Error && error.message === 'Twin JSON 值无效',
    );
    assert.equal(getterInvoked, false);
    const validReplay = fixture.store.appendAgentEvent(eventInput({
      entityId: fixture.po.id, payload: { changed: true }, status: 'failed',
    }));
    assert.equal(validReplay.id, first.id);
    assert.equal(validReplay.status, 'completed');
    assert.deepEqual(validReplay.payload, { original: 'immutable' });
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM twin_agent_events').get()?.['count'], 1);
  } finally {
    fixture.db.close();
  }
});

test('filtered and byte-truncated snapshots contain no orphan evidence, relations, supersedes, or conflicts', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const store = new SqliteManufacturingContextStore(db, 'tenant:integrity');
  try {
    const root = store.upsertEntity({
      entityType: 'purchase_order', canonicalKey: 'po:integrity', label: 'PO integrity', lifecycleState: 'sent',
      attributes: { businessObjectId: 'po:integrity' }, state: { missingFacts: ['grn'] },
      sourceWatermark: 'w', effectiveAt: at, observedAt: at,
    });
    const supplier = store.upsertEntity({
      entityType: 'supplier', canonicalKey: 'supplier:integrity', label: 'Supplier integrity', lifecycleState: 'active',
      attributes: { businessObjectId: 'supplier:integrity' }, state: {}, sourceWatermark: 'w', effectiveAt: at, observedAt: at,
    });
    const omittedOld = store.appendEvidence({
      entityId: root.id, sourceSemantics: 'model_derived', sourceKind: 'model', sourceId: 'run:large',
      sourceVersion: '1', sourceHash: 'hash:large', factPath: 'purchase_order.status', value: 'x'.repeat(530_000),
      confidence: 0.5, effectiveAt: at, observedAt: at, actorId: 'ai:model', rawReference: fullReference('model:large'),
    });
    const selected = store.appendEvidence({
      entityId: root.id, sourceSemantics: 'verified_external', sourceKind: 'odoo', sourceId: 'po:integrity',
      sourceVersion: '9', sourceHash: 'hash:selected', factPath: 'purchase_order.status', value: 'sent',
      confidence: 1, effectiveAt: at, observedAt: at, actorId: 'source:odoo',
      rawReference: fullReference('purchase_order:po:integrity', '9'), supersedesEvidenceId: omittedOld.id,
    });
    const supplierEvidence = store.appendEvidence({
      entityId: supplier.id, sourceSemantics: 'deterministic', sourceKind: 'readywork', sourceId: 'supplier:integrity',
      sourceVersion: '1', sourceHash: 'hash:supplier', factPath: 'supplier.status', value: 'active', confidence: 1,
      effectiveAt: at, observedAt: at, actorId: 'system', rawReference: fullReference('supplier:supplier:integrity'),
    });
    store.upsertRelation({
      relationType: 'ordered_from', fromEntityId: root.id, toEntityId: supplier.id, status: 'active',
      sourceEvidenceId: omittedOld.id, validFrom: at,
    });

    const included = store.createSnapshot({
      employeeId: 'ai:integrity', rootEntityId: root.id, purpose: 'read',
      scope: { ...readScope, entityTypes: ['purchase_order', 'supplier'] },
    });
    const includedEvidence = included.snapshot['evidence'] as Array<Record<string, any>>;
    assert.ok(includedEvidence.some((item) => item['id'] === selected.id));
    assert.ok(includedEvidence.some((item) => item['id'] === supplierEvidence.id));
    assert.equal(includedEvidence.some((item) => item['id'] === omittedOld.id), false);
    assert.equal('supersedesEvidenceId' in includedEvidence.find((item) => item['id'] === selected.id)!, false);
    assert.deepEqual(included.snapshot['relations'], []);
    assert.deepEqual(included.snapshot['conflicts'], []);
    assert.equal(typeof (included.snapshot['cursors'] as Record<string, unknown>)['evidence'], 'string');
    assert.equal(typeof (included.snapshot['cursors'] as Record<string, unknown>)['relations'], 'string');

    const rootOnly = store.createSnapshot({
      employeeId: 'ai:integrity', rootEntityId: root.id, purpose: 'read-root-only',
      scope: { ...readScope, entityTypes: ['purchase_order'] },
    });
    const retainedEntityIds = new Set(snapshotEntities(rootOnly.snapshot).map((item) => item['id']));
    assert.deepEqual([...retainedEntityIds], [root.id]);
    assert.equal((rootOnly.snapshot['evidence'] as Array<Record<string, any>>)
      .some((item) => item['entityId'] === supplier.id), false);
    assert.deepEqual(rootOnly.snapshot['relations'], []);
    assert.equal(rootOnly.snapshot['truncated'], true);
    assert.equal(typeof (rootOnly.snapshot['cursors'] as Record<string, unknown>)['entities'], 'string');
    assert.deepEqual(rootOnly.snapshot['missingFacts'], ['grn']);
  } finally {
    db.close();
  }
});

test('snapshot graph pruning reaches a fixed point across multi-hop relation evidence dependencies', () => {
  const root = graphEntity('entity:root', 'purchase_order');
  const supplier = graphEntity('entity:supplier', 'supplier');
  const contact = graphEntity('entity:contact', 'contact');
  const filteredTail = graphEntity('entity:filtered-tail', 'invoice');
  const evidenceOne = graphEvidence('evidence:one', root.id, {
    relationId: 'relation:two', supersedesEvidenceId: 'evidence:two',
  });
  const evidenceTwo = graphEvidence('evidence:two', root.id, { relationId: 'relation:three' });
  const evidenceThree = graphEvidence('evidence:three', filteredTail.id);
  const retainedEvidence = graphEvidence('evidence:retained', root.id, { supersedesEvidenceId: evidenceTwo.id });
  const relationOne = graphRelation('relation:one', root.id, supplier.id, evidenceOne.id);
  const relationTwo = graphRelation('relation:two', root.id, contact.id, evidenceTwo.id);
  const relationThree = graphRelation('relation:three', root.id, filteredTail.id, evidenceThree.id);
  const neighborhood: TwinNeighborhood = {
    root,
    entities: [root, supplier, contact, filteredTail],
    relations: [relationOne, relationTwo, relationThree],
    evidence: [evidenceOne, evidenceTwo, evidenceThree, retainedEvidence],
    agentEvents: [],
    sourceWatermark: 'w',
    conflicts: [{
      factPath: retainedEvidence.factPath,
      selectedEvidenceId: retainedEvidence.id,
      conflictingEvidenceIds: [evidenceOne.id],
    }],
    missingFacts: ['receipt'],
    truncated: false,
    nextCursor: null,
  };

  const snapshot = contextModule.buildTwinSnapshot(neighborhood, {
    ...readScope,
    entityTypes: ['purchase_order', 'supplier', 'contact'],
  });
  const entities = snapshot['entities'] as Array<Record<string, string>>;
  const relations = snapshot['relations'] as Array<Record<string, string>>;
  const evidence = snapshot['evidence'] as Array<Record<string, string>>;
  const conflicts = snapshot['conflicts'] as Array<Record<string, any>>;
  const entityIds = new Set(entities.map((item) => item['id']));
  const relationIds = new Set(relations.map((item) => item['id']));
  const evidenceIds = new Set(evidence.map((item) => item['id']));
  for (const relation of relations) {
    assert.equal(entityIds.has(relation['fromEntityId']), true);
    assert.equal(entityIds.has(relation['toEntityId']), true);
    assert.equal(evidenceIds.has(relation['sourceEvidenceId']), true);
  }
  for (const item of evidence) {
    if (item['entityId'] !== undefined) assert.equal(entityIds.has(item['entityId']), true);
    if (item['relationId'] !== undefined) assert.equal(relationIds.has(item['relationId']), true);
    if (item['supersedesEvidenceId'] !== undefined) assert.equal(evidenceIds.has(item['supersedesEvidenceId']), true);
  }
  for (const conflict of conflicts) {
    assert.equal(evidenceIds.has(conflict['selectedEvidenceId']), true);
    assert.equal(conflict['conflictingEvidenceIds'].every((id: string) => evidenceIds.has(id)), true);
  }
  assert.deepEqual(relations, []);
  assert.deepEqual(evidence.map((item) => item['id']), [retainedEvidence.id]);
  assert.deepEqual(conflicts, []);
  assert.equal(snapshot['truncated'], true);
  assert.equal(typeof snapshot['cursors']['entities'], 'string');
  assert.equal(typeof snapshot['cursors']['evidence'], 'string');
  assert.equal(typeof snapshot['cursors']['relations'], 'string');
  assert.deepEqual(snapshot['missingFacts'], ['receipt']);
});

test('Agent Event tuple collisions cannot cross employee or input snapshot ownership', () => {
  const fixture = contextFixture();
  try {
    const firstSnapshot = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id, purpose: 'collision:first', scope: readScope,
    });
    const secondSnapshot = fixture.store.createSnapshot({
      employeeId: 'ai:po', rootEntityId: fixture.po.id, purpose: 'collision:second', scope: readScope,
    });
    const first = fixture.store.appendAgentEvent(eventInput({
      inputSnapshotId: firstSnapshot.id, payload: { private: 'first-owner-payload' },
    }));
    let employeeCollision = '';
    let snapshotCollision = '';
    assert.throws(() => fixture.store.appendAgentEvent(eventInput({
      employeeId: 'ai:other', payload: { private: 'must-not-return-first' },
    })), (error: unknown) => {
      employeeCollision = error instanceof Error ? error.message : String(error);
      return true;
    });
    assert.throws(() => fixture.store.appendAgentEvent(eventInput({
      inputSnapshotId: secondSnapshot.id, payload: { private: 'must-not-return-first' },
    })), (error: unknown) => {
      snapshotCollision = error instanceof Error ? error.message : String(error);
      return true;
    });
    assert.equal(employeeCollision, snapshotCollision);
    assert.doesNotMatch(employeeCollision, /ai:po|first-owner-payload|collision:first/);
    assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM twin_agent_events').get()?.['count'], 1);
    assert.equal(fixture.store.appendAgentEvent(eventInput({ inputSnapshotId: firstSnapshot.id })).id, first.id);
  } finally {
    fixture.db.close();
  }
});

test('snapshots include only recent entity-less events tied to their snapshot or root business object', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const store = new SqliteManufacturingContextStore(db, 'tenant:events');
  try {
    const root = store.upsertEntity({
      entityType: 'purchase_order', canonicalKey: 'po:events', label: 'PO events', lifecycleState: 'sent',
      attributes: { businessObjectId: 'po:events' }, state: { missingFacts: [] },
      sourceWatermark: 'w', effectiveAt: at, observedAt: at,
    });
    const other = store.upsertEntity({
      entityType: 'purchase_order', canonicalKey: 'po:other', label: 'PO other', lifecycleState: 'sent',
      attributes: { businessObjectId: 'po:other' }, state: { missingFacts: [] },
      sourceWatermark: 'w', effectiveAt: at, observedAt: at,
    });
    const inputSnapshot = store.createSnapshot({ employeeId: 'ai:events', rootEntityId: root.id, purpose: 'events:input', scope: readScope });
    const otherSnapshot = store.createSnapshot({ employeeId: 'ai:events', rootEntityId: other.id, purpose: 'events:other', scope: readScope });
    const relevantIds: string[] = [];
    for (let index = 0; index < 52; index += 1) {
      const createdAt = `2026-08-29T00:${String(index).padStart(2, '0')}:00.000Z`;
      relevantIds.push(store.appendAgentEvent(eventInput({
        employeeId: 'ai:events', runId: 'run:recent', taskId: `task:recent:${index}`, inputSnapshotId: inputSnapshot.id,
        entityId: undefined, businessObjectId: undefined, createdAt,
      })).id);
    }
    const businessObjectEvent = store.appendAgentEvent(eventInput({
      runId: 'run:business-object', taskId: 'task:business-object', entityId: undefined,
      businessObjectId: 'po:events', createdAt: '2026-08-29T00:59:00.000Z',
    }));
    const unrelatedByObject = store.appendAgentEvent(eventInput({
      runId: 'run:unrelated-object', taskId: 'task:unrelated-object', entityId: undefined,
      businessObjectId: 'po:other', createdAt: '2026-08-29T00:58:00.000Z',
    }));
    const unrelatedBySnapshot = store.appendAgentEvent(eventInput({
      employeeId: 'ai:events', runId: 'run:unrelated-snapshot', taskId: 'task:unrelated-snapshot', entityId: undefined,
      inputSnapshotId: otherSnapshot.id, createdAt: '2026-08-29T00:57:00.000Z',
    }));

    const created = store.createSnapshot({ employeeId: 'ai:events', rootEntityId: root.id, purpose: 'events:result', scope: readScope });
    const events = created.snapshot['agentEvents'] as Array<Record<string, any>>;
    const ids = new Set(events.map((item) => item['id']));
    assert.equal(events.length, 50);
    assert.equal(ids.has(businessObjectEvent.id), true);
    assert.equal(ids.has(unrelatedByObject.id), false);
    assert.equal(ids.has(unrelatedBySnapshot.id), false);
    assert.equal(ids.has(relevantIds[0]!), false);
    assert.equal(ids.has(relevantIds.at(-1)!), true);
    assert.equal(typeof (created.snapshot['cursors'] as Record<string, unknown>)['agentEvents'], 'string');
  } finally {
    db.close();
  }
});

test('root-only overflow fails closed without a partial snapshot row', () => {
  const db = new DatabaseSync(':memory:');
  initializeControlPlaneSchema(db);
  const store = new SqliteManufacturingContextStore(db, 'tenant:overflow');
  try {
    const root = store.upsertEntity({
      entityType: 'purchase_order', canonicalKey: 'po:overflow', label: 'PO overflow', lifecycleState: 'sent',
      attributes: { requiredRootPayload: '根'.repeat(530_000) }, state: { missingFacts: ['grn'] },
      sourceWatermark: 'w', effectiveAt: at, observedAt: at,
    });
    assert.throws(() => store.createSnapshot({
      employeeId: 'ai:overflow', rootEntityId: root.id, purpose: 'overflow', scope: readScope,
    }), /512 KiB|snapshot limit|快照上限/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM twin_snapshots').get()?.['count'], 0);
    assert.deepEqual(store.getEntity(root.id)?.state['missingFacts'], ['grn']);
  } finally {
    db.close();
  }
});
