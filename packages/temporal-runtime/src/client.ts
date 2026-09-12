import { Client, Connection, WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { approvalSignal, externalEventSignal, runStateQuery, workforceGraphWorkflow } from './workflows.js';
import type { ApprovalSignalPayload, ExternalEventSignalPayload, TemporalGraphRunInput, TemporalRunState } from './types.js';

export interface TemporalRuntimeOptions {
  address?: string;
  namespace?: string;
  taskQueue?: string;
  timeoutMs?: number;
}

export interface TemporalRuntimeHealth {
  connected: boolean;
  address: string;
  namespace: string;
  taskQueue: string;
  /** 至少有一个 Worker 正在轮询该 Workflow Task Queue。 */
  workerObserved: boolean;
  pollerCount: number;
  error?: string;
  workerError?: string;
}

export class TemporalRuntimeClient {
  private connection?: Connection;
  private client?: Client;
  readonly address: string;
  readonly namespace: string;
  readonly taskQueue: string;
  readonly timeoutMs: number;

  constructor(options: TemporalRuntimeOptions = {}) {
    this.address = options.address ?? process.env['TEMPORAL_ADDRESS'] ?? '127.0.0.1:7233';
    this.namespace = options.namespace ?? process.env['TEMPORAL_NAMESPACE'] ?? 'default';
    this.taskQueue = options.taskQueue ?? process.env['TEMPORAL_TASK_QUEUE'] ?? 'readywork-workforce';
    this.timeoutMs = options.timeoutMs ?? Number(process.env['READYWORK_TEMPORAL_TIMEOUT_MS'] ?? 10_000);
  }

  async connect(): Promise<Client> {
    if (this.client) return this.client;
    this.connection = await withTimeout('Temporal 连接', Connection.connect({ address: this.address }), this.timeoutMs);
    this.client = new Client({ connection: this.connection, namespace: this.namespace });
    return this.client;
  }

  async health(): Promise<TemporalRuntimeHealth> {
    try {
      await this.connect();
      try {
        const response = await withTimeout('Temporal Worker 状态查询', this.connection!.workflowService.describeTaskQueue({
          namespace: this.namespace,
          taskQueue: { name: this.taskQueue },
        }), this.timeoutMs);
        const pollerCount = response.pollers?.length ?? 0;
        return {
          connected: true,
          address: this.address,
          namespace: this.namespace,
          taskQueue: this.taskQueue,
          workerObserved: pollerCount > 0,
          pollerCount,
        };
      } catch (error) {
        return {
          connected: true,
          address: this.address,
          namespace: this.namespace,
          taskQueue: this.taskQueue,
          workerObserved: false,
          pollerCount: 0,
          workerError: boundedError(error),
        };
      }
    } catch (error) {
      return {
        connected: false,
        address: this.address,
        namespace: this.namespace,
        taskQueue: this.taskQueue,
        workerObserved: false,
        pollerCount: 0,
        error: boundedError(error),
      };
    }
  }

  async start(input: TemporalGraphRunInput): Promise<{ workflowId: string; temporalRunId: string }> {
    const client = await this.connect();
    const workflowId = `readywork:${input.definition.tenantId}:${input.definition.employeeId}:${input.runId}`;
    try {
      const handle = await withTimeout('Temporal 工作流启动', client.workflow.start(workforceGraphWorkflow, {
        workflowId,
        taskQueue: this.taskQueue,
        args: [input],
      }), this.timeoutMs);
      return { workflowId, temporalRunId: handle.firstExecutionRunId };
    } catch (error) {
      if (error instanceof WorkflowExecutionAlreadyStartedError) {
        const handle = client.workflow.getHandle(workflowId);
        const description = await withTimeout('Temporal 工作流状态查询', handle.describe(), this.timeoutMs);
        return { workflowId, temporalRunId: description.runId };
      }
      throw error;
    }
  }

  async approve(workflowId: string, payload: ApprovalSignalPayload): Promise<void> {
    const client = await this.connect();
    await withTimeout('Temporal 审批信号', client.workflow.getHandle(workflowId).signal(approvalSignal, payload), this.timeoutMs);
  }

  async signalEvent(workflowId: string, payload: ExternalEventSignalPayload): Promise<void> {
    const client = await this.connect();
    await withTimeout('Temporal 外部事件信号', client.workflow.getHandle(workflowId).signal(externalEventSignal, payload), this.timeoutMs);
  }

  async queryState(workflowId: string): Promise<TemporalRunState> {
    const client = await this.connect();
    return withTimeout('Temporal 状态查询', client.workflow.getHandle(workflowId).query(runStateQuery), this.timeoutMs);
  }

  async cancel(workflowId: string): Promise<void> {
    const client = await this.connect();
    await withTimeout('Temporal 取消', client.workflow.getHandle(workflowId).cancel(), this.timeoutMs);
  }

  async close(): Promise<void> {
    await this.connection?.close();
    this.connection = undefined;
    this.client = undefined;
  }
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization|api[-_]?key|token|secret|password|credential)(\s*[=:]\s*)([^\s,;}&]+)/gi, '$1$2[REDACTED]')
    .slice(0, 500);
}

async function withTimeout<T>(label: string, operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时`)), Math.max(1, timeoutMs));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
