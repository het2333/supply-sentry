import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 极简 DeepSeek Harness JSON-RPC stdio 客户端。
 *
 * 直接实现 @deepseek-ai/dsh-sdk-protocol 的 wire 契约（newline-delimited JSON-RPC 2.0），
 * 不依赖 DSH 仓库内部包：spawn runtime 子进程 → initialize 握手 → session/prompt →
 * 收集 session.event 直到 session.status idle → 提取 finalResponse。
 *
 * 协议参考：DSH checkout 的 packages/sdk/protocol + packages/sdk/client。
 */

export class HarnessRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessRuntimeError';
  }
}

export interface HarnessRuntimeOptions {
  /** 可执行文件（'node' 或 dsh-jsonrpc-agent bin） */
  command: string;
  /** 参数（通常为 ['--import','tsx', binScript, cordisYml]） */
  args: string[];
  /** runtime 进程工作目录（DSH 仓库根） */
  cwd: string;
  /** 追加到父进程 env 的变量（DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DSH_CWD / DSH_SESSION_ROOT） */
  env: Record<string, string>;
  /**
   * 额外从父进程继承的环境变量名。默认只继承进程启动所需的无业务密钥变量；
   * ERP、邮件、数据库和 Readywork Credential 不会自动进入 Harness。
   */
  inheritedEnvAllowlist?: string[];
  provider?: string;
  model?: string;
  /** Passed through a controlled child env to the decision-only Cordis composition. */
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high' | 'max';
  maxTokens?: number;
  initializeTimeoutMs?: number;
  turnTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

interface Notification {
  method: string;
  params: Record<string, unknown>;
}

interface Waiter {
  predicate: (n: Notification) => boolean;
  resolve: (n: Notification) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface HarnessPromptResult {
  sessionId: string;
  finalResponse: string;
  events: unknown[];
}

/** 可注入的 runtime 接口（供适配器测试替换） */
export interface HarnessRuntimeLike {
  start(): Promise<void>;
  prompt(sessionId: string, contentBlocks: { type: 'text'; text: string }[]): Promise<HarnessPromptResult>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUTS = {
  initialize: 60_000,
  turn: 180_000,
  request: 30_000,
};

const SAFE_PARENT_ENV = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const;

export class HarnessRuntime implements HarnessRuntimeLike {
  private child: ChildProcess | undefined;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private queue: Notification[] = [];
  private waiters: Waiter[] = [];
  private stderrTail: string[] = [];
  private lineBuffer = '';
  private started = false;
  private closed = false;
  private startPromise: Promise<void> | undefined;
  private terminatedError: HarnessRuntimeError | undefined;

  constructor(readonly opts: HarnessRuntimeOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (this.closed) throw new HarnessRuntimeError('runtime 已关闭');
    if (this.terminatedError) throw this.terminatedError;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    this.child = spawn(this.opts.command, this.opts.args, {
      cwd: this.opts.cwd,
      env: childEnvironment(process.env, this.opts.env, this.opts.inheritedEnvAllowlist),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 60) this.stderrTail.shift();
    });
    this.child.on('exit', (code, signal) => {
      this.started = false;
      const error = new HarnessRuntimeError(`DSH runtime 已退出 (code=${code}, signal=${signal})\nstderr: ${this.stderrTail.join('').slice(-2000)}`);
      this.terminatedError ??= error;
      this.failAll(error);
    });
    this.child.on('error', (err) => {
      const error = new HarnessRuntimeError(`DSH runtime 启动失败: ${err.message}`);
      this.terminatedError ??= error;
      this.failAll(error);
    });

    try {
      const result = (await this.request(
        'initialize',
        {
          cwd: this.opts.cwd,
          provider: this.opts.provider ?? 'deepseek-official',
          model: this.opts.model ?? 'deepseek-v4-flash',
          ...(this.opts.maxTokens === undefined ? {} : { maxTokens: this.opts.maxTokens }),
        },
        this.opts.initializeTimeoutMs ?? DEFAULT_TIMEOUTS.initialize,
      )) as { serverInfo?: { name?: string } };
      const name = result?.serverInfo?.name;
      if (name !== 'deepseek-harness-sdk-runtime') {
        throw new HarnessRuntimeError(`initialize 握手失败: serverInfo.name=${String(name)}`);
      }
      if (this.terminatedError) throw this.terminatedError;
      this.started = true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async prompt(sessionId: string, contentBlocks: { type: 'text'; text: string }[]): Promise<HarnessPromptResult> {
    await this.start();
    const receipt = (await this.request(
      'session/prompt',
      { sessionId, contentBlocks },
      this.opts.requestTimeoutMs ?? DEFAULT_TIMEOUTS.request,
    )) as { messageId?: string };
    const messageId = receipt?.messageId;
    if (!messageId) throw new HarnessRuntimeError('session/prompt 未返回 messageId');

    const events: unknown[] = [];
    let received = false;
    const deadline = Date.now() + (this.opts.turnTimeoutMs ?? DEFAULT_TIMEOUTS.turn);
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new HarnessRuntimeError(`agent 回合超时 (session ${sessionId})`);
      const n = await this.nextNotification(
        (n) =>
          (n.method === 'session.event' || n.method === 'session.status') && String(n.params['sessionId']) === sessionId,
        remaining,
      );
      if (n.method === 'session.event') {
        if (String(n.params['sessionId']) !== sessionId) continue;
        const event = n.params['event'];
        events.push(event);
        if (!received && isInboxReceipt(event, messageId)) received = true;
        continue;
      }
      // session.status
      if (received && n.params['status'] === 'idle') break;
    }
    return { sessionId, finalResponse: finalResponseText(events), events };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new HarnessRuntimeError('runtime 已关闭'));
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      child.stdin?.end();
      await Promise.race([exited, sleep(2_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await Promise.race([exited, sleep(2_000)]);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    } catch {
      // 进程已死等边界情况
    } finally {
      // 释放 stdio 管道句柄，否则事件循环不会退出
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }

  // ---------------------------------------------------------------- 内部

  private request(method: string, params: object, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new HarnessRuntimeError('runtime 已关闭'));
    if (this.terminatedError) return Promise.reject(this.terminatedError);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin) {
        reject(new HarnessRuntimeError('runtime stdin 不可用'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HarnessRuntimeError(`请求超时: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new HarnessRuntimeError(`写入失败: ${err.message}`));
        }
      });
    });
  }

  private settle(id: number, ok: unknown | undefined, err: Error | undefined): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    const timer = p.timer;
    if (timer) clearTimeout(timer);
    if (err) p.reject(err);
    else p.resolve(ok);
  }

  private onStdout(chunk: string): void {
    this.lineBuffer += chunk;
    const parts = this.lineBuffer.split('\n');
    this.lineBuffer = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.failAll(new HarnessRuntimeError(`runtime 输出了非 JSON 行: ${line.slice(0, 200)}`));
        return;
      }
      this.handleMessage(parsed);
    }
  }

  private handleMessage(msg: unknown): void {
    if (msg === null || typeof msg !== 'object') return;
    const m = msg as Record<string, unknown>;
    if (typeof m['id'] === 'number') {
      if (m['error'] !== undefined) {
        const e = m['error'] as { message?: string };
        this.settle(m['id'], undefined, new HarnessRuntimeError(`JSON-RPC 错误: ${e?.message ?? JSON.stringify(e)}`));
      } else {
        this.settle(m['id'], m['result'], undefined);
      }
      return;
    }
    if (typeof m['method'] === 'string' && m['params'] && typeof m['params'] === 'object') {
      const n: Notification = { method: m['method'], params: m['params'] as Record<string, unknown> };
      const waiterIdx = this.waiters.findIndex((w) => w.predicate(n));
      if (waiterIdx >= 0) {
        const [w] = this.waiters.splice(waiterIdx, 1);
        if (w) {
          clearTimeout(w.timer);
          w.resolve(n);
        }
      } else {
        this.queue.push(n);
      }
    }
  }

  private nextNotification(predicate: (n: Notification) => boolean, timeoutMs: number): Promise<Notification> {
    const idx = this.queue.findIndex(predicate);
    if (idx >= 0) return Promise.resolve(this.queue.splice(idx, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new HarnessRuntimeError(`等待通知超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  private failAll(err: Error): void {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }
}

// ---------------------------------------------------------------- 语义助手

function isInboxReceipt(value: unknown, messageId: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v['type'] !== 'agent/inbox/spliced' || !v['data'] || typeof v['data'] !== 'object') return false;
  const data = v['data'] as Record<string, unknown>;
  const inserted = data['inserted'];
  return Array.isArray(inserted) && inserted.some((m) => m !== null && typeof m === 'object' && (m as Record<string, unknown>)['id'] === messageId);
}

export function finalResponseText(events: unknown[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event === null || typeof event !== 'object') continue;
    const e = event as Record<string, unknown>;
    if (e['type'] !== 'assistant/message') continue;
    const data = e['data'] as Record<string, unknown> | undefined;
    const message = data?.['message'] as Record<string, unknown> | undefined;
    const content = message?.['content'];
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b): b is Record<string, unknown> => b !== null && typeof b === 'object' && b['type'] === 'text')
      .map((b) => String(b['text'] ?? ''))
      .join('');
    // DSH 可能在真正回复之后追加一个只承载 usage 的空 assistant/message。
    if (text) return text;
  }
  return '';
}

function childEnvironment(
  parent: NodeJS.ProcessEnv,
  explicit: Record<string, string>,
  extraAllowlist: string[] | undefined,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of [...SAFE_PARENT_ENV, ...(extraAllowlist ?? [])]) {
    const value = parent[key];
    if (value !== undefined) result[key] = value;
  }
  return { ...result, ...explicit };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
