export interface TimerHandle {
  readonly id: number;
  cancel(): void;
}

/** 内存定时器（Wait/Resume 的 untilMs 恢复路径） */
export class Scheduler {
  private nextId = 1;
  private timers = new Map<number, NodeJS.Timeout>();

  schedule(delayMs: number, fn: () => void): TimerHandle {
    const id = this.nextId++;
    const t = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, delayMs);
    this.timers.set(id, t);
    return { id, cancel: () => this.cancel(id) };
  }

  scheduleAt(when: Date, fn: () => void): TimerHandle {
    const delay = Math.max(0, when.getTime() - Date.now());
    return this.schedule(delay, fn);
  }

  cancel(id: number): void {
    const t = this.timers.get(id);
    if (t) {
      clearTimeout(t);
      this.timers.delete(id);
    }
  }

  cancelAll(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
