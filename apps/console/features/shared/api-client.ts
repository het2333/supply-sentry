export class ReadyworkApiError extends Error {
  constructor(message: string, readonly status: number, readonly payload?: unknown) {
    super(message);
    this.name = "ReadyworkApiError";
  }
}

export type ApiRequestOptions = Omit<RequestInit, "body"> & { body?: unknown; timeoutMs?: number };

export const READYWORK_AUTH_REQUIRED_EVENT = "readywork:auth-required";
export type ReadyworkAuthRequiredReason = "expired" | "signed_out";

export interface PublicDemoApiRuntime {
  getGeneration: () => number | null;
  onGeneration: (generation: number) => void;
  onGenerationConflict: (currentGeneration: number | null) => Promise<void> | void;
}

let publicDemoApiRuntime: PublicDemoApiRuntime | null = null;

/** The callbacks point to React-owned state; the API module never persists the generation itself. */
export function configurePublicDemoApiRuntime(runtime: PublicDemoApiRuntime): () => void {
  publicDemoApiRuntime = runtime;
  return () => {
    if (publicDemoApiRuntime === runtime) publicDemoApiRuntime = null;
  };
}

export function notifyAuthenticationRequired(reason: ReadyworkAuthRequiredReason = "expired"): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(READYWORK_AUTH_REQUIRED_EVENT, { detail: { reason } }));
}

export const employeeScopedPath = (path: string, employeeId: string) =>
  `${path}${path.includes("?") ? "&" : "?"}employee_id=${encodeURIComponent(employeeId)}`;

/** 控制台唯一 HTTP 入口：统一鉴权、JSON 编解码和错误语义。 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { timeoutMs = 15_000, signal: callerSignal, ...requestOptions } = options;
  const headers = new Headers(options.headers);
  const formBody = typeof FormData !== "undefined" && options.body instanceof FormData;
  const body: BodyInit | undefined = options.body === undefined
    ? undefined
    : formBody
      ? options.body as FormData
      : JSON.stringify(options.body);
  headers.set("accept", "application/json");
  if (options.body !== undefined && !formBody) headers.set("content-type", "application/json");
  const method = (options.method ?? (options.body === undefined ? "GET" : "POST")).toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && !headers.has("x-readywork-demo-generation")) {
    const generation = publicDemoApiRuntime?.getGeneration();
    if (generation !== null && generation !== undefined) headers.set("x-readywork-demo-generation", String(generation));
  }
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(path, {
      ...requestOptions,
      credentials: "same-origin",
      signal: controller.signal,
      headers,
      body,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    let payload: unknown = text;
    if (contentType.includes("application/json") && text) {
      try { payload = JSON.parse(text) as unknown; } catch { payload = { error: "服务器返回了无效响应" }; }
    }
    const responseGeneration = Number(response.headers.get("x-readywork-demo-generation"));
    if (Number.isSafeInteger(responseGeneration) && responseGeneration > 0) publicDemoApiRuntime?.onGeneration(responseGeneration);
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload ? String((payload as { error: unknown }).error) : `请求失败（${response.status}）`;
      if (response.status === 401 && !path.startsWith("/api/auth/")) notifyAuthenticationRequired();
      if (response.status === 409 && payload && typeof payload === "object"
        && (payload as { code?: unknown }).code === "DEMO_GENERATION_CONFLICT") {
        const current = Number((payload as { currentGeneration?: unknown }).currentGeneration);
        const normalizedCurrent = Number.isSafeInteger(current) && current > 0 ? current : null;
        if (normalizedCurrent !== null) publicDemoApiRuntime?.onGeneration(normalizedCurrent);
        await publicDemoApiRuntime?.onGenerationConflict(normalizedCurrent);
      }
      throw new ReadyworkApiError(message, response.status, payload);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof ReadyworkApiError) throw error;
    if (timedOut) throw new ReadyworkApiError("请求超时，请稍后重试", 408, { code: "REQUEST_TIMEOUT" });
    if (controller.signal.aborted) throw new ReadyworkApiError("请求已取消", 499, { code: "REQUEST_ABORTED" });
    throw new ReadyworkApiError("网络连接失败，请检查服务状态", 0);
  } finally {
    window.clearTimeout(timer);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}
