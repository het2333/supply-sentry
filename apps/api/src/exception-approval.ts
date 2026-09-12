import type { ApprovalRequest, Task } from '@readywork/core';

export type ExceptionApprovalPreflight =
  | { kind: 'proceed' }
  | { kind: 'replayed'; taskStatus: Task['status'] }
  | { kind: 'conflict' }
  | { kind: 'invalid'; error: string };

/**
 * 异常工作台只是同一审批的一个视图，不能据此绕过任务、租户或挂起关联。
 * 相同结论的网络重试不再次驱动工作流；相反结论必须保持冲突。
 */
export function preflightExceptionApproval(
  approval: ApprovalRequest,
  task: Task | undefined,
  tenantId: string,
  decision: 'approved' | 'rejected',
): ExceptionApprovalPreflight {
  if (!task || task.tenantId !== tenantId) return { kind: 'invalid', error: '审批关联任务不存在或不属于当前租户' };
  if (approval.taskId !== task.id) return { kind: 'invalid', error: '审批与关联任务不一致' };
  if (approval.status === 'pending') {
    if (task.status !== 'waiting_approval' || task.checkpoint.pendingApprovalId !== approval.id) {
      return { kind: 'invalid', error: '审批不再是当前任务的等待项' };
    }
    return { kind: 'proceed' };
  }
  if (approval.status === decision) return { kind: 'replayed', taskStatus: task.status };
  return { kind: 'conflict' };
}
