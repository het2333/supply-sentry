import { InMemoryApprovalRepository, type ApprovalRepository } from './repositories.js';
import type { EntityId, ISODateTime } from './types.js';
import { nowIso, uid } from './types.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
  id: EntityId;
  taskId: EntityId;
  ruleId: string;
  title: string;
  message: string;
  payload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: ISODateTime;
  decidedAt?: ISODateTime;
  decidedBy?: string;
  reason?: string;
}

export class ApprovalStore {
  private repo: ApprovalRepository;

  constructor(repo?: ApprovalRepository) {
    this.repo = repo ?? new InMemoryApprovalRepository();
  }

  create(input: {
    taskId: EntityId;
    ruleId: string;
    title: string;
    message: string;
    payload: Record<string, unknown>;
  }): ApprovalRequest {
    const req: ApprovalRequest = {
      id: uid('appr'),
      ...input,
      status: 'pending',
      requestedAt: nowIso(),
    };
    this.repo.save(req);
    return req;
  }

  get(id: EntityId): ApprovalRequest | undefined {
    return this.repo.get(id);
  }

  listByTask(taskId: EntityId): ApprovalRequest[] {
    return this.repo.listByTask(taskId);
  }

  listPending(): ApprovalRequest[] {
    return this.repo.listPending();
  }

  decide(id: EntityId, status: 'approved' | 'rejected', by: string, reason?: string): ApprovalRequest {
    const req = this.repo.get(id);
    if (!req) throw new Error(`审批请求不存在: ${id}`);
    if (req.status !== 'pending') throw new Error(`审批请求已处理: ${id}`);
    req.status = status;
    req.decidedAt = nowIso();
    req.decidedBy = by;
    req.reason = reason;
    this.repo.save(req);
    return req;
  }
}
