import { extname } from 'node:path';
import * as mammoth from 'mammoth';
import ExcelJS from 'exceljs';

export type ProcurementDocumentParseStatus = 'parsed' | 'needs_ocr' | 'needs_specialist';

/**
 * Kept as an interface so production uses Tesseract while tests (and a future
 * managed OCR connector) can supply a deterministic implementation.  The
 * adapter deliberately receives bytes only: it never gets database handles or
 * credentials.
 */
export interface ProcurementOcrAdapter {
  recognize(input: {
    readonly content: Uint8Array;
    readonly contentType: string;
    readonly language: string;
  }): Promise<{ readonly text: string; readonly confidence?: number | null }>;
}

export interface ProcurementDocumentParseResult {
  readonly status: ProcurementDocumentParseStatus;
  readonly parser: 'plain-text' | 'pdfjs' | 'mammoth' | 'exceljs' | 'tesseract.js' | 'image-metadata' | 'cad-metadata';
  readonly text: string;
  readonly preview: string;
  readonly structuredData: Readonly<Record<string, unknown>>;
}

const MAX_EXTRACTED_TEXT = 250_000;
const MAX_PREVIEW = 1_500;
const MAX_OCR_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_OCR_PIXELS = 40_000_000;
const DEFAULT_OCR_TIMEOUT_MS = 45_000;
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'application/json']);

function normalizedText(value: string): string {
  return value.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_EXTRACTED_TEXT);
}

function preview(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_PREVIEW);
}

function csvRows(value: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '"') {
      if (quoted && value[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (character === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (character !== '\r') cell += character;
  }
  row.push(cell);
  if (row.some((item) => item.length > 0)) rows.push(row);
  return rows.slice(0, 500).map((item) => item.slice(0, 100));
}

function imageDimensions(content: Uint8Array, contentType: string): { width?: number; height?: number } {
  const view = Buffer.from(content);
  if (contentType === 'image/png' && view.length >= 24 && view.subarray(1, 4).toString('ascii') === 'PNG') {
    return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
  }
  if (contentType === 'image/gif' && view.length >= 10 && view.subarray(0, 3).toString('ascii') === 'GIF') {
    return { width: view.readUInt16LE(6), height: view.readUInt16LE(8) };
  }
  if (contentType === 'image/jpeg') {
    let offset = 2;
    while (offset + 8 < view.length) {
      if (view[offset] !== 0xff) { offset += 1; continue; }
      const marker = view[offset + 1];
      const length = view.readUInt16BE(offset + 2);
      if (marker !== undefined && ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf))) {
        return { height: view.readUInt16BE(offset + 5), width: view.readUInt16BE(offset + 7) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return {};
}

function configuredOcrLanguage(): string {
  // English is bundled/downloaded by Tesseract by default. Chinese is opt-in
  // because chi_sim can require a first-run traineddata download. Operations
  // can set READYWORK_OCR_LANG=eng+chi_sim after provisioning its langPath.
  return process.env['READYWORK_OCR_LANG']?.trim() || 'eng';
}

function configuredOcrTimeoutMs(): number {
  const configured = Number(process.env['READYWORK_OCR_TIMEOUT_MS']);
  if (!Number.isFinite(configured)) return DEFAULT_OCR_TIMEOUT_MS;
  return Math.min(120_000, Math.max(5_000, Math.floor(configured)));
}

async function runTesseractOcr(input: {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly language: string;
}): Promise<{ readonly text: string; readonly confidence?: number | null }> {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker(input.language, undefined, {
    // Prevent verbose OCR progress output from becoming application logs.
    logger: () => undefined,
  });
  try {
    const result = await worker.recognize(Buffer.from(input.content));
    return { text: result.data.text, confidence: result.data.confidence };
  } finally {
    await worker.terminate();
  }
}

async function ocrRasterImage(input: {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly dimensions: { readonly width?: number; readonly height?: number };
  readonly ocrAdapter?: ProcurementOcrAdapter;
  readonly ocrLanguage?: string;
  readonly ocrTimeoutMs?: number;
}): Promise<ProcurementDocumentParseResult> {
  if (input.content.byteLength > MAX_OCR_IMAGE_BYTES) {
    throw new Error(`图片超过 OCR 资源上限（最大 ${MAX_OCR_IMAGE_BYTES / 1024 / 1024} MB）`);
  }
  const pixelCount = (input.dimensions.width ?? 0) * (input.dimensions.height ?? 0);
  if (pixelCount > MAX_OCR_PIXELS) {
    throw new Error(`图片像素超过 OCR 资源上限（最大 ${MAX_OCR_PIXELS.toLocaleString()} 像素）`);
  }
  const language = input.ocrLanguage?.trim() || configuredOcrLanguage();
  const adapter = input.ocrAdapter ?? { recognize: runTesseractOcr };
  const timeoutMs = input.ocrTimeoutMs ?? configuredOcrTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      adapter.recognize({ content: input.content, contentType: input.contentType, language }),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`OCR 超时（${timeoutMs} ms）`)), timeoutMs); }),
    ]);
    const text = normalizedText(result.text);
    const confidence = typeof result.confidence === 'number' && Number.isFinite(result.confidence)
      ? Math.max(0, Math.min(100, result.confidence)) : null;
    return {
      status: 'parsed',
      parser: 'tesseract.js',
      text,
      preview: preview(text),
      structuredData: {
        contentType: input.contentType,
        language,
        confidence,
        characterCount: text.length,
        ...input.dimensions,
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function parsePdf(content: Uint8Array): Promise<ProcurementDocumentParseResult> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(content), useSystemFonts: true }).promise;
  const pages: Array<{ page: number; text: string }> = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const contentResult = await page.getTextContent();
    const pageText = contentResult.items
      .map((item) => ('str' in item ? item.str : ''))
      .filter(Boolean)
      .join(' ');
    pages.push({ page: pageNumber, text: normalizedText(pageText) });
  }
  const text = normalizedText(pages.map((page) => page.text).join('\n\n'));
  return {
    status: text ? 'parsed' : 'needs_ocr',
    parser: 'pdfjs',
    text,
    preview: preview(text),
    structuredData: { pageCount: pdf.numPages, pages: pages.map((page) => ({ page: page.page, characterCount: page.text.length })) },
  };
}

async function parseDocx(content: Uint8Array): Promise<ProcurementDocumentParseResult> {
  const result = await mammoth.extractRawText({ buffer: Buffer.from(content) });
  const text = normalizedText(result.value);
  return {
    status: 'parsed',
    parser: 'mammoth',
    text,
    preview: preview(text),
    structuredData: { characterCount: text.length, warnings: result.messages.map((item) => item.message).slice(0, 20) },
  };
}

function cellValue(value: ExcelJS.CellValue): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if ('result' in value && value.result !== undefined) return cellValue(value.result);
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('richText' in value) return value.richText.map((item) => item.text).join('');
  if ('error' in value) return value.error;
  return JSON.stringify(value);
}

async function parseWorkbook(content: Uint8Array): Promise<ProcurementDocumentParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(content).buffer);
  const sheets: Array<{ name: string; rowCount: number; columnCount: number; rows: Array<Array<string | number | boolean | null>> }> = [];
  const textParts: string[] = [];
  workbook.eachSheet((worksheet) => {
    const rows: Array<Array<string | number | boolean | null>> = [];
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      const cells = Array.from({ length: Math.min(100, row.cellCount) }, (_, index) => cellValue(row.getCell(index + 1).value));
      rows.push(cells);
      textParts.push(cells.filter((value) => value !== null).join('\t'));
    });
    sheets.push({ name: worksheet.name, rowCount: worksheet.rowCount, columnCount: worksheet.columnCount, rows: rows.slice(0, 200) });
  });
  const text = normalizedText(textParts.join('\n'));
  return {
    status: 'parsed',
    parser: 'exceljs',
    text,
    preview: preview(text),
    structuredData: { sheetCount: sheets.length, sheets },
  };
}

/**
 * Deterministic local extraction plus bounded local OCR for raster images.
 * Image-only PDFs are still surfaced as `needs_ocr` because rasterising PDFs is
 * a separate, explicitly provisioned capability.
 */
export async function parseProcurementDocument(input: {
  readonly fileName: string;
  readonly contentType: string;
  readonly content: Uint8Array;
  readonly ocrAdapter?: ProcurementOcrAdapter;
  readonly ocrLanguage?: string;
  readonly ocrTimeoutMs?: number;
}): Promise<ProcurementDocumentParseResult> {
  const contentType = input.contentType.toLowerCase().split(';', 1)[0] ?? '';
  const extension = extname(input.fileName).toLowerCase();
  if (TEXT_TYPES.has(contentType)) {
    const text = normalizedText(Buffer.from(input.content).toString('utf8'));
    if (contentType === 'application/json') {
      const data = JSON.parse(text) as unknown;
      return { status: 'parsed', parser: 'plain-text', text, preview: preview(text), structuredData: { characterCount: text.length, rootType: Array.isArray(data) ? 'array' : typeof data, data } };
    }
    if (contentType === 'text/csv') {
      const rows = csvRows(text);
      return { status: 'parsed', parser: 'plain-text', text, preview: preview(text), structuredData: { characterCount: text.length, rowCount: rows.length, rows } };
    }
    return { status: 'parsed', parser: 'plain-text', text, preview: preview(text), structuredData: { characterCount: text.length } };
  }
  if (contentType === 'application/pdf' || extension === '.pdf') return parsePdf(input.content);
  if (contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || extension === '.docx') return parseDocx(input.content);
  if (contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || extension === '.xlsx') return parseWorkbook(input.content);
  if (contentType.startsWith('image/')) {
    const dimensions = imageDimensions(input.content, contentType);
    return ocrRasterImage({
      content: input.content,
      contentType,
      dimensions,
      ...(input.ocrAdapter ? { ocrAdapter: input.ocrAdapter } : {}),
      ...(input.ocrLanguage ? { ocrLanguage: input.ocrLanguage } : {}),
      ...(input.ocrTimeoutMs ? { ocrTimeoutMs: input.ocrTimeoutMs } : {}),
    });
  }
  if (['.dwg', '.dxf', '.step', '.stp', '.iges', '.igs'].includes(extension)) {
    return { status: 'needs_specialist', parser: 'cad-metadata', text: '', preview: '', structuredData: { extension, sizeBytes: input.content.byteLength } };
  }
  throw new Error(`尚不支持解析该文件类型: ${contentType || extension || '未知'}`);
}
