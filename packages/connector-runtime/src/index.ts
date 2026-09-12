import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CredentialRequirement, JsonValue, NodeParameterDescriptor, NodePortDescriptor } from '@readywork/graph-runtime';

export interface ConnectorActionDescriptor {
  id: string;
  name: string;
  description: string;
  inputs: NodePortDescriptor[];
  outputs: NodePortDescriptor[];
  parameters: NodeParameterDescriptor[];
  sideEffects: string[];
  idempotent: boolean;
  risk: 'read' | 'low' | 'medium' | 'high' | 'critical';
}

export type ConnectorCredentialFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select';

/**
 * Credential fields are declarative so the control plane can generate forms,
 * validate required values and test a connection without connector-specific UI.
 */
export interface ConnectorCredentialFieldDescriptor {
  id: string;
  label: string;
  type: ConnectorCredentialFieldType;
  required?: boolean;
  secret?: boolean;
  defaultValue?: JsonValue;
  placeholder?: string;
  description?: string;
  options?: Array<{ label: string; value: string }>;
}

export interface ConnectorCredentialSchema {
  type: string;
  name: string;
  fields: ConnectorCredentialFieldDescriptor[];
  testable?: boolean;
}

export interface ConnectorDescriptor {
  id: string;
  version: number;
  name: string;
  description: string;
  icon: string;
  vendor: string;
  category?: string;
  runtime: 'builtin' | 'local_process' | 'debug_process' | 'remote_http' | 'serverless';
  credentials: CredentialRequirement[];
  credentialSchemas?: ConnectorCredentialSchema[];
  actions: ConnectorActionDescriptor[];
  tags?: string[];
  distribution?: 'builtin' | 'official' | 'customer';
}

export interface ConnectorExecutionContext {
  tenantId: string;
  employeeId: string;
  runId: string;
  nodeRunId: string;
  idempotencyKey: string;
  credentials: Record<string, unknown>;
  timeoutMs: number;
}

export interface ConnectorExecutionResult {
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
  externalId?: string;
  cost?: number;
}

export interface ConnectorAdapter {
  execute(action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorExecutionResult>;
  health?(): Promise<{ ok: boolean; message?: string }>;
  close?(): Promise<void>;
}

export class ConnectorRegistry {
  private descriptors = new Map<string, ConnectorDescriptor>();
  private adapters = new Map<string, ConnectorAdapter>();

  register(descriptor: ConnectorDescriptor, adapter: ConnectorAdapter): void {
    const key = `${descriptor.id}@${descriptor.version}`;
    if (this.descriptors.has(key)) throw new Error(`Connector 已注册: ${key}`);
    if (descriptor.actions.length === 0) throw new Error(`Connector 必须声明至少一个 action: ${key}`);
    this.descriptors.set(key, structuredClone(descriptor));
    this.adapters.set(key, adapter);
  }

  describe(id: string, version: number): ConnectorDescriptor | undefined {
    const found = this.descriptors.get(`${id}@${version}`);
    return found ? structuredClone(found) : undefined;
  }

  list(): ConnectorDescriptor[] {
    return [...this.descriptors.values()].map((descriptor) => structuredClone(descriptor));
  }

  async unregister(id: string, version: number): Promise<boolean> {
    const key = `${id}@${version}`;
    const adapter = this.adapters.get(key);
    if (!adapter) return false;
    if (adapter.close) await adapter.close();
    this.adapters.delete(key);
    this.descriptors.delete(key);
    return true;
  }

  async health(id: string, version: number): Promise<{ ok: boolean; message?: string }> {
    const adapter = this.adapters.get(`${id}@${version}`);
    if (!adapter) return { ok: false, message: `Connector 未安装: ${id}@${version}` };
    return adapter.health ? adapter.health() : { ok: true, message: '运行时未提供主动健康检查' };
  }

  async execute(id: string, version: number, action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorExecutionResult> {
    const key = `${id}@${version}`;
    const descriptor = this.descriptors.get(key);
    const adapter = this.adapters.get(key);
    if (!descriptor || !adapter) throw new Error(`Connector 未注册: ${key}`);
    const actionDescriptor = descriptor.actions.find((item) => item.id === action);
    if (!actionDescriptor) throw new Error(`Connector action 不存在: ${key}.${action}`);
    return adapter.execute(action, input, context);
  }
}

export interface PluginManifest {
  id: string;
  version: string;
  protocolVersion: 1;
  command: string;
  args?: string[];
  envAllowlist?: string[];
  timeoutMs?: number;
  maxConcurrency?: number;
}

interface PluginRequest {
  id: string;
  method: 'execute' | 'health' | 'shutdown';
  payload: Record<string, unknown>;
}

interface PluginResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

/**
 * Local connector plugins run as isolated subprocesses over newline-delimited JSON.
 * Only explicitly allowlisted environment variables are inherited.
 */
export class LocalProcessConnectorAdapter implements ConnectorAdapter {
  private sequence = 0;
  private child?: ReturnType<typeof spawn>;
  private pending = new Map<string, { resolve: (response: PluginResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private active = 0;
  private slotWaiters: Array<() => void> = [];
  private closing = false;

  constructor(private manifest: PluginManifest) {}

  async execute(action: string, input: Record<string, unknown>, context: ConnectorExecutionContext): Promise<ConnectorExecutionResult> {
    const response = await this.invoke('execute', { action, input, context: { ...context, credentials: context.credentials } }, context.timeoutMs);
    return response.ok ? { ok: true, output: redactPluginValue(response.result) as Record<string, unknown> } : { ok: false, error: safePluginError(response.error) };
  }

  async health(): Promise<{ ok: boolean; message?: string }> {
    const response = await this.invoke('health', {}, Math.min(5000, this.manifest.timeoutMs ?? 5000));
    return { ok: response.ok, message: response.ok ? undefined : safePluginError(response.error) };
  }

  async close(): Promise<void> {
    if (!this.child || this.closing) return;
    this.closing = true;
    try {
      await this.invoke('shutdown', {}, 3000);
    } catch {
      // Force termination below when the plugin cannot acknowledge shutdown.
    } finally {
      this.child?.kill('SIGTERM');
      this.child = undefined;
      this.closing = false;
    }
  }

  private async invoke(method: PluginRequest['method'], payload: Record<string, unknown>, timeoutMs: number): Promise<PluginResponse> {
    await this.acquireSlot();
    const child = this.ensureProcess();
    const request: PluginRequest = { id: `${this.manifest.id}:${++this.sequence}`, method, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        this.releaseSlot();
        reject(new Error(`Connector 插件超时: ${this.manifest.id}`));
      }, timeoutMs || this.manifest.timeoutMs || 30_000);
      this.pending.set(request.id, { resolve, reject, timer });
      if (!child.stdin?.writable) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        this.releaseSlot();
        reject(new Error(`Connector 插件输入流不可用: ${this.manifest.id}`));
        return;
      }
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  private ensureProcess(): ReturnType<typeof spawn> {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const env: Record<string, string> = {};
    for (const name of this.manifest.envAllowlist ?? []) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const child = spawn(this.manifest.command, this.manifest.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '', ...env },
      shell: false,
    });
    this.child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', () => { /* drain plugin diagnostics without exposing them to callers */ });
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => this.handleLine(line));
    }
    child.on('error', (error) => this.failProcess(error));
    child.on('exit', (code) => {
      if (this.child === child) this.child = undefined;
      if (!this.closing || (code !== null && code !== 0)) this.failProcess(new Error(`Connector 插件异常退出（代码 ${code ?? 'unknown'}）`));
    });
    return child;
  }

  private handleLine(line: string): void {
    try {
      const response = JSON.parse(line) as PluginResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      this.releaseSlot();
      pending.resolve(response);
    } catch {
      // Plugin logs belong on stderr; non-protocol stdout is ignored.
    }
  }

  private failProcess(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.releaseSlot();
    }
    this.pending.clear();
  }

  private async acquireSlot(): Promise<void> {
    const maxConcurrency = Math.max(1, this.manifest.maxConcurrency ?? 1);
    if (this.active < maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    this.active += 1;
  }

  private releaseSlot(): void {
    this.active = Math.max(0, this.active - 1);
    this.slotWaiters.shift()?.();
  }
}

function safePluginError(_error: unknown): string {
  return 'Connector 插件执行失败';
}

function redactPluginValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => redactPluginValue(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      /(authorization|api[-_]?key|token|secret|password|passwd|credential|cookie)/i.test(key) ? '[REDACTED]' : redactPluginValue(item, depth + 1),
    ]));
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(/(authorization|api[-_]?key|token|secret|password|credential)(\s*[=:]\s*)([^\s,;}&]+)/gi, '$1$2[REDACTED]');
  }
  return value;
}

export interface EncryptedCredential {
  version: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  tag: string;
  ciphertext: string;
}

export class CredentialVault {
  private key: Buffer;

  constructor(secret: string | undefined = process.env['READYWORK_CREDENTIAL_KEY']) {
    if (!secret || secret.length < 24) throw new Error('READYWORK_CREDENTIAL_KEY 至少需要 24 个字符');
    this.key = createHash('sha256').update(secret).digest();
  }

  encrypt(value: Record<string, JsonValue>): EncryptedCredential {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { version: 1, algorithm: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  }

  decrypt(value: EncryptedCredential): Record<string, JsonValue> {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as Record<string, JsonValue>;
  }
}
