import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { parseProcurementDocument } from '../src/procurement-document-parser.js';

function simplePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test('extracts persisted plain text deterministically', async () => {
  const result = await parseProcurementDocument({
    fileName: '采购需求.txt',
    contentType: 'text/plain',
    content: Buffer.from('气动阀 PV-30\n需求数量: 40 件', 'utf8'),
  });
  assert.equal(result.status, 'parsed');
  assert.equal(result.parser, 'plain-text');
  assert.match(result.text, /PV-30/);
});

test('extracts real XLSX cells and worksheet metadata', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('报价');
  sheet.addRow(['物料', '数量', '单价']);
  sheet.addRow(['PV-30', 40, 128.5]);
  const bytes = await workbook.xlsx.writeBuffer();
  const result = await parseProcurementDocument({
    fileName: '供应商报价.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: new Uint8Array(bytes),
  });
  assert.equal(result.status, 'parsed');
  assert.match(result.text, /PV-30/);
  assert.equal(result.structuredData['sheetCount'], 1);
});

test('extracts real PDF text and page count', async () => {
  const result = await parseProcurementDocument({ fileName: '需求.pdf', contentType: 'application/pdf', content: simplePdf('PV-30 quantity 40') });
  assert.equal(result.status, 'parsed');
  assert.match(result.text, /PV-30 quantity 40/);
  assert.equal(result.structuredData['pageCount'], 1);
});

function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  png.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

test('runs bounded OCR for raster images and persists text, confidence, and dimensions', async () => {
  const png = pngHeader(640, 480);
  // The adapter keeps this test fully local: it proves our OCR integration
  // without downloading traineddata or invoking a browser worker.
  const result = await parseProcurementDocument({
    fileName: '图纸.png', contentType: 'image/png', content: png,
    ocrLanguage: 'eng+chi_sim',
    ocrAdapter: { recognize: async (input) => {
      assert.equal(input.language, 'eng+chi_sim');
      return { text: 'PV-30 气动阀\n数量 40', confidence: 93.4 };
    } },
  });
  assert.equal(result.status, 'parsed');
  assert.equal(result.parser, 'tesseract.js');
  assert.match(result.text, /PV-30/);
  assert.equal(result.structuredData['confidence'], 93.4);
  assert.equal(result.structuredData['width'], 640);
  assert.equal(result.structuredData['height'], 480);
});

test('fails a timed out OCR job so the worker can retry it', async () => {
  await assert.rejects(
    parseProcurementDocument({
      fileName: 'slow.png', contentType: 'image/png', content: pngHeader(10, 10), ocrTimeoutMs: 5,
      ocrAdapter: { recognize: async () => new Promise(() => undefined) },
    }),
    /OCR 超时/,
  );
});

test('rejects oversized images before invoking OCR', async () => {
  let called = false;
  await assert.rejects(
    parseProcurementDocument({
      fileName: 'huge.png', contentType: 'image/png', content: pngHeader(10_000, 10_000),
      ocrAdapter: { recognize: async () => { called = true; return { text: '' }; } },
    }),
    /像素超过 OCR 资源上限/,
  );
  assert.equal(called, false);
});
