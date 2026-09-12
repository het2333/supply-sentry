import type { IncomingMessage } from 'node:http';

export class ProcurementChatMultipartError extends Error {
  constructor(readonly code: 'MULTIPART_REQUIRED' | 'REQUEST_TOO_LARGE' | 'INVALID_MULTIPART') { super(code); }
}

/** Shared native FormData parser for PO Context Chat and Route Context Chat. */
export async function readProcurementChatMultipartForm(req: IncomingMessage, maxRequestBytes: number): Promise<FormData> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!/^multipart\/form-data\s*;/iu.test(contentType)) throw new ProcurementChatMultipartError('MULTIPART_REQUIRED');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxRequestBytes) throw new ProcurementChatMultipartError('REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  try { return await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData(); }
  catch { throw new ProcurementChatMultipartError('INVALID_MULTIPART'); }
}
