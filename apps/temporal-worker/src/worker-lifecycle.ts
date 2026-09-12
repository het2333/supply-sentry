export interface ShutdownableWorker {
  /** Temporal Worker 的 shutdown 只发出停止领取任务的请求，不代表已排空 Activity。 */
  shutdown(): void | Promise<void>;
}

export interface ClosableResource {
  close(): void | Promise<void>;
}

export interface TemporalWorkerLifecyclePorts {
  worker: ShutdownableWorker;
  /** 必须是 worker.run() 的同一个 Promise；它兑现时才表示活动已排空。 */
  waitForWorkerDrain(): Promise<void>;
  agentRuntime: ClosableResource;
  connection: ClosableResource;
}

/**
 * 将停止接单和资源回收分成两个阶段。收到 SIGTERM 时只能调用 requestShutdown：
 * 已领取的 Activity 仍能完成对 Agent Runtime 的调用。等 worker.run() 结束后再调用 close。
 */
export function createTemporalWorkerLifecycle(ports: TemporalWorkerLifecyclePorts): {
  requestShutdown(): Promise<void>;
  close(): Promise<void>;
} {
  let stopRequest: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  const requestShutdown = (): Promise<void> => {
    if (stopRequest) return stopRequest;
    try {
      stopRequest = Promise.resolve(ports.worker.shutdown());
    } catch (error) {
      stopRequest = Promise.reject(error);
    }
    return stopRequest;
  };

  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      const failures: unknown[] = [];
      try {
        await requestShutdown();
      } catch (error) {
        failures.push(error);
      }
      try {
        await ports.waitForWorkerDrain();
      } catch (error) {
        failures.push(error);
      }
      // 无论停止或排空是否报错，都必须尝试回收 DSH 子进程与 NativeConnection。
      for (const resource of [ports.agentRuntime, ports.connection]) {
        try {
          await resource.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Temporal Worker 关闭不完整');
    })();
    return closing;
  };
  return { requestShutdown, close };
}
