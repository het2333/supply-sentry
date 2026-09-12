import { createHash } from 'node:crypto';
import type { AttachmentObjectStorage } from './attachment-object-storage.js';

export interface StoredAttachmentContentRecord {
  readonly tenantId: string;
  readonly attachmentId: string;
  readonly version: number;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly storageBackend: string;
  readonly objectKey?: string | null;
  readonly content?: Uint8Array | null;
}

export class ProcurementAttachmentContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProcurementAttachmentContentError';
  }
}

/**
 * The only byte-loading path used by parsing, downloads and outbound email.
 * Both SQLite and object storage are checked against the immutable DB digest.
 */
export async function loadProcurementAttachmentContent(
  record: StoredAttachmentContentRecord,
  objectStorage?: AttachmentObjectStorage,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  if (record.storageBackend === 'sqlite') {
    if (!record.content) throw new ProcurementAttachmentContentError(`附件 ${record.attachmentId} 缺少 SQLite 内容`);
    bytes = record.content;
  } else if (record.storageBackend === 's3') {
    if (!objectStorage) throw new ProcurementAttachmentContentError(`附件 ${record.attachmentId} 的对象存储未配置`);
    const value = await objectStorage.get({
      tenantId: record.tenantId,
      attachmentId: record.attachmentId,
      version: record.version,
      sha256: record.sha256.toLowerCase(),
      sizeBytes: record.sizeBytes,
    });
    if (record.objectKey && value.metadata.key !== record.objectKey) {
      throw new ProcurementAttachmentContentError(`附件 ${record.attachmentId} 的对象键与数据库记录不一致`);
    }
    bytes = value.body;
  } else {
    throw new ProcurementAttachmentContentError(`附件 ${record.attachmentId} 的存储后端不受支持`);
  }

  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== record.sizeBytes) {
    throw new ProcurementAttachmentContentError(`附件 ${record.attachmentId} 大小与数据库记录不一致`);
  }
  if (digest !== record.sha256.toLowerCase()) {
    throw new ProcurementAttachmentContentError(`附件 ${record.attachmentId} sha256 与数据库记录不一致`);
  }
  return bytes;
}
