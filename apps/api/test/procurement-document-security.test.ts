import assert from 'node:assert/strict';
import test from 'node:test';
import { assessProcurementDocumentSecurity } from '../src/procurement-document-security.js';

const bytes = (value: string) => new TextEncoder().encode(value);

test('accepts matching PDF magic bytes and MIME', () => {
  const result = assessProcurementDocumentSecurity({ fileName: '图纸.pdf', declaredMimeType: 'application/pdf', bytes: bytes('%PDF-1.7\n') });
  assert.equal(result.securityStatus, 'pending_scan');
  assert.equal(result.detectedContentType, 'application/pdf');
  assert.equal(result.safeForExternalSend, false);
});

test('quarantines extension/MIME spoofing and executable headers', () => {
  const spoof = assessProcurementDocumentSecurity({ fileName: '报价.pdf', declaredMimeType: 'application/pdf', bytes: bytes('not a pdf') });
  assert.equal(spoof.securityStatus, 'quarantined');
  assert.equal(spoof.safeForProcessing, false);
  const executable = assessProcurementDocumentSecurity({ fileName: '报价.pdf', declaredMimeType: 'application/pdf', bytes: new Uint8Array([0x4d, 0x5a, 0x90]) });
  assert.match(executable.reason, /可执行/);
});

test('accepts common image signatures and rejects text with binary controls', () => {
  const png = assessProcurementDocumentSecurity({ fileName: 'photo.png', declaredMimeType: 'image/png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) });
  assert.equal(png.securityStatus, 'pending_scan');
  const text = assessProcurementDocumentSecurity({ fileName: 'data.csv', declaredMimeType: 'text/csv', bytes: new Uint8Array([0x61, 0x00, 0x62]) });
  assert.equal(text.securityStatus, 'quarantined');
});

test('recognises OOXML ZIP containers by extension and entries', () => {
  const docx = assessProcurementDocumentSecurity({ fileName: 'spec.docx', declaredMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: bytes('PK\x03\x04....word/document.xml') });
  assert.equal(docx.detectedContentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(docx.securityStatus, 'pending_scan');
  const wrong = assessProcurementDocumentSecurity({ fileName: 'spec.xlsx', declaredMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: bytes('PK\x03\x04....word/document.xml') });
  assert.equal(wrong.securityStatus, 'quarantined');
});

test('does not claim malware scanning', () => {
  const result = assessProcurementDocumentSecurity({ fileName: 'x.txt', declaredMimeType: 'text/plain', bytes: bytes('safe') });
  assert.match(result.reason, /未执行(?:病毒|恶意软件)扫描/);
});

test('recognises supported CAD headers while keeping them pending malware scan', () => {
  const step = assessProcurementDocumentSecurity({
    fileName: 'valve.step', declaredMimeType: 'application/octet-stream', bytes: bytes('ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION();'),
  });
  assert.equal(step.detectedContentType, 'model/step');
  assert.equal(step.securityStatus, 'pending_scan');
  assert.equal(step.safeForProcessing, true);
});
