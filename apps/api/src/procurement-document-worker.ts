import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { createProcurementRepository } from '@readywork/persistence';
import { parseProcurementDocument, type ProcurementOcrAdapter } from './procurement-document-parser.js';
import { assessProcurementDocumentSecurity } from './procurement-document-security.js';
import { scanProcurementDocumentForMalware, type ProcurementMalwareScanResult } from './procurement-malware-scanner.js';
import type { AttachmentObjectStorage } from './attachment-object-storage.js';
import { loadProcurementAttachmentContent } from './procurement-attachment-content.js';
import { evaluatePo } from './procurement-import-documents.js';
import { refreshPoIntakeCandidateForAttachment } from './procurement-po-intake.js';

interface AttachmentRow {
  readonly id: string;
  readonly file_name: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly version: number;
  readonly storage_backend: string;
  readonly object_key: string | null;
  readonly content: Uint8Array | null;
  readonly status: string;
}

export interface ProcurementDocumentWorkerResult {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly pendingMalwareScan: number;
}

export class ProcurementDocumentWorker {
  readonly workerId = `document-worker:${randomUUID()}`;
  private readonly malwareScanner: (content: Uint8Array) => Promise<ProcurementMalwareScanResult>;
  private readonly ocrAdapter?: ProcurementOcrAdapter;
  private readonly ocrTimeoutMs?: number;
  private readonly ocrLanguage?: string;
  private readonly objectStorage?: AttachmentObjectStorage;

  constructor(
    private readonly db: DatabaseSync,
    options: {
      readonly malwareScanner?: (content: Uint8Array) => Promise<ProcurementMalwareScanResult>;
      /** Dependency-injection seam for a managed OCR connector and offline tests. */
      readonly ocrAdapter?: ProcurementOcrAdapter;
      readonly ocrTimeoutMs?: number;
      readonly ocrLanguage?: string;
      readonly objectStorage?: AttachmentObjectStorage;
    } = {},
  ) {
    this.malwareScanner = options.malwareScanner ?? scanProcurementDocumentForMalware;
    this.ocrAdapter = options.ocrAdapter;
    this.ocrTimeoutMs = options.ocrTimeoutMs;
    this.ocrLanguage = options.ocrLanguage;
    this.objectStorage = options.objectStorage;
  }

  runPendingTenants(): Promise<ProcurementDocumentWorkerResult[]> {
    const now = new Date().toISOString();
    const tenants = this.db.prepare(`SELECT DISTINCT tenant_id FROM procurement_document_jobs
      WHERE attempts < max_attempts AND ((status='queued' AND available_at<=?) OR (status='processing' AND lease_expires_at<=?))`)
      .all(now, now) as Array<{ tenant_id: string }>;
    return Promise.all(tenants.map((row) => this.runTenant(row.tenant_id)));
  }

  async runTenant(tenantId: string, limit = 4): Promise<ProcurementDocumentWorkerResult> {
    const repository = createProcurementRepository(this.db, tenantId);
    const claimedAt = new Date().toISOString();
    const jobs = repository.claimDocumentJobs({ workerId: this.workerId, claimedAt, leaseDurationMs: 120_000, limit });
    let completed = 0;
    let failed = 0;
    let pendingMalwareScan = 0;
    for (const job of jobs) {
      const lockToken = job.lockToken;
      if (!lockToken) { failed += 1; continue; }
      try {
        const attachment = this.db.prepare(`SELECT id,file_name,content_type,size_bytes,sha256,version,storage_backend,object_key,content,status FROM procurement_attachments
          WHERE tenant_id=? AND id=?`).get(tenantId, job.attachmentId) as unknown as AttachmentRow | undefined;
        if (!attachment || attachment.status !== 'active') throw new Error('附件不存在或已失效');
        const content = await loadProcurementAttachmentContent({
          tenantId,
          attachmentId: attachment.id,
          version: attachment.version,
          sha256: attachment.sha256,
          sizeBytes: attachment.size_bytes,
          storageBackend: attachment.storage_backend,
          objectKey: attachment.object_key,
          content: attachment.content,
        }, this.objectStorage);
        const security = assessProcurementDocumentSecurity({
          fileName: attachment.file_name,
          declaredMimeType: attachment.content_type,
          bytes: content,
        });
        if (!security.safeForProcessing) {
          this.updateSecurity(tenantId, attachment.id, 'quarantined', security.detectedContentType, security.reason);
          repository.failDocumentJob({ id: job.id, lockToken, failedAt: new Date().toISOString(), error: security.reason, retry: false });
          this.recordAudit(tenantId, attachment.id, 'security_quarantined', { reason: security.reason, detectedContentType: security.detectedContentType });
          this.refreshImportDocumentEvaluation(tenantId, attachment.id);
          failed += 1;
          continue;
        }

        const malware = await this.malwareScanner(content);
        if (malware.status === 'infected') {
          this.updateSecurity(tenantId, attachment.id, 'quarantined', security.detectedContentType, malware.detail);
          repository.failDocumentJob({ id: job.id, lockToken, failedAt: new Date().toISOString(), error: malware.detail, retry: false });
          this.recordAudit(tenantId, attachment.id, 'malware_quarantined', { engine: malware.engine, detail: malware.detail });
          this.refreshImportDocumentEvaluation(tenantId, attachment.id);
          failed += 1;
          continue;
        }
        if (malware.status === 'clean') {
          this.updateSecurity(tenantId, attachment.id, 'clean', security.detectedContentType, null);
          this.recordAudit(tenantId, attachment.id, 'malware_scan_clean', { engine: malware.engine, detail: malware.detail });
        } else {
          pendingMalwareScan += 1;
          const detail = malware.status === 'unavailable'
            ? '恶意软件扫描引擎未配置；已阻止附件外发'
            : `恶意软件扫描失败：${malware.detail}`;
          this.updateSecurity(tenantId, attachment.id, malware.status === 'error' ? 'scan_failed' : 'pending_scan', security.detectedContentType, detail);
          this.recordAudit(tenantId, attachment.id, malware.status === 'error' ? 'malware_scan_failed' : 'malware_scan_pending', { engine: malware.engine, detail });
        }

        const parsed = await parseProcurementDocument({
          fileName: attachment.file_name,
          contentType: security.detectedContentType,
          content,
          ...(this.ocrAdapter ? { ocrAdapter: this.ocrAdapter } : {}),
          ...(this.ocrTimeoutMs ? { ocrTimeoutMs: this.ocrTimeoutMs } : {}),
          ...(this.ocrLanguage ? { ocrLanguage: this.ocrLanguage } : {}),
        });
        repository.completeDocumentJob({
          id: job.id,
          lockToken,
          completedAt: new Date().toISOString(),
          detectedContentType: security.detectedContentType,
          ...(parsed.preview ? { extractedTextPreview: parsed.preview } : {}),
          result: { status: parsed.status, parser: parsed.parser, text: parsed.text, preview: parsed.preview, structuredData: parsed.structuredData },
        });
        if (parsed.status !== 'parsed') {
          this.db.prepare(`UPDATE procurement_attachments SET processing_status=? WHERE tenant_id=? AND id=?`)
            .run(parsed.status, tenantId, attachment.id);
        }
        this.recordAudit(tenantId, attachment.id, parsed.status === 'parsed' ? 'document_parsed' : parsed.status, {
          parser: parsed.parser,
          status: parsed.status,
          structuredData: parsed.structuredData,
        });
        this.refreshImportDocumentEvaluation(tenantId, attachment.id);
        completed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedAt = new Date().toISOString();
        const retryAt = new Date(Date.now() + Math.min(60_000, 1_000 * (2 ** Math.max(0, job.attempts - 1)))).toISOString();
        try { repository.failDocumentJob({ id: job.id, lockToken, failedAt, error: message, retryAt }); } catch { /* lease was already finalized */ }
        this.recordAudit(tenantId, job.attachmentId, 'document_processing_failed', { error: message });
        this.refreshImportDocumentEvaluation(tenantId, job.attachmentId);
        failed += 1;
      }
    }
    return { claimed: jobs.length, completed, failed, pendingMalwareScan };
  }

  private updateSecurity(tenantId: string, attachmentId: string, status: string, detectedContentType: string, error: string | null): void {
    this.db.prepare(`UPDATE procurement_attachments SET security_status=?,detected_content_type=?,scan_error=? WHERE tenant_id=? AND id=?`)
      .run(status, detectedContentType, error, tenantId, attachmentId);
  }

  private recordAudit(tenantId: string, attachmentId: string, action: string, detail: Readonly<Record<string, unknown>>): void {
    const row = this.db.prepare(`SELECT requisition_id,owner_type,COALESCE(owner_id,requisition_id) AS owner_id
      FROM procurement_attachments WHERE tenant_id=? AND id=?`)
      .get(tenantId, attachmentId) as { requisition_id: string; owner_type: string; owner_id: string } | undefined;
    if (!row) return;
    this.db.prepare(`INSERT INTO procurement_attachment_audit
      (tenant_id,id,attachment_id,requisition_id,actor_id,action,owner_type,owner_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(tenantId, `attachment-audit:${randomUUID()}`, attachmentId, row.requisition_id, this.workerId, action,
        row.owner_type, row.owner_id, JSON.stringify(detail), new Date().toISOString());
  }

  private refreshImportDocumentEvaluation(tenantId: string, attachmentId: string): void {
    refreshPoIntakeCandidateForAttachment(this.db, tenantId, attachmentId);
    const binding = this.db.prepare(`SELECT po_id FROM procurement_import_documents
      WHERE tenant_id=? AND attachment_id=? AND status='active'`)
      .get(tenantId, attachmentId) as { po_id: string } | undefined;
    if (!binding) return;
    try { evaluatePo(this.db, tenantId, binding.po_id, new Date()); } catch { /* processing outcome remains authoritative even if a stale policy cannot be evaluated */ }
  }
}
