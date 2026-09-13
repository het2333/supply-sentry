"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Eye, EyeOff, Loader2, Lock, Mail } from "lucide-react";
import { usePathname } from "next/navigation";
import { LanguageSwitcher } from "@/features/localization/ui-language";
import {
  apiRequest,
  READYWORK_AUTH_REQUIRED_EVENT,
  type ReadyworkAuthRequiredReason,
  ReadyworkApiError,
} from "@/features/shared/api-client";
import { useUiLanguage } from "@/features/localization/ui-language";
import { usePublicDemo } from "@/features/public-demo/public-demo-context";

type Account = { username: string; name: string; role: string; humanId: string };
type SessionPayload = { ok: true; account: Account; expiresAt: string; demoMode?: boolean };
type AuthConfig = { mode: "local_demo" | "external" | "public_demo"; passwordLogin: boolean; demoMode?: boolean };
type GateState = "checking" | "authenticated" | "unauthenticated" | "unavailable";

function errorMessage(error: unknown): string {
  if (error instanceof ReadyworkApiError) return error.message;
  return "登录请求失败，请稍后重试";
}

function ReadyworkMark({ loading = false }: { loading?: boolean }) {
  return <span className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-[13px] bg-gradient-to-br from-[#3b82f6] to-[#1d4ed8] text-white shadow-[0_8px_18px_-8px_rgba(37,99,235,0.65)]">
    {loading ? <Loader2 className="size-5 animate-spin" /> : <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M9.5 23V9.5h7.1c3.6 0 5.9 2 5.9 5.1 0 2.2-1.2 3.9-3.3 4.7L23 23h-4.1l-3.2-3.2h-2.6V23H9.5Zm3.6-6.3h3.1c1.7 0 2.7-.7 2.7-2.1 0-1.3-1-2-2.7-2h-3.1v4.1Z" fill="currentColor" />
    </svg>}
  </span>;
}

function AuthBackdrop({ children }: { children: ReactNode }) {
  return <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#f8fafc] px-4 py-12">
    <LanguageSwitcher className="absolute right-5 top-5 z-20" />
    <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white via-[#f8fafc] to-[#eff3f9]/80" />
    <div className="pointer-events-none absolute right-10 top-24 hidden h-40 w-48 opacity-60 sm:block" style={{ backgroundImage: "radial-gradient(rgb(166, 176, 191) 1.2px, transparent 1.2px)", backgroundSize: "16px 16px" }} />
    <svg className="pointer-events-none absolute inset-x-0 bottom-0 h-64 w-full text-[#2563eb]/[0.06]" viewBox="0 0 1440 320" preserveAspectRatio="none" aria-hidden="true">
      <path fill="currentColor" d="M0,224L60,213.3C120,203,240,181,360,181.3C480,181,600,203,720,213.3C840,224,960,224,1080,202.7C1200,181,1320,139,1380,117.3L1440,96L1440,320L0,320Z" />
      <path fill="currentColor" d="M0,288L80,272C160,256,320,224,480,224C640,224,800,256,960,261.3C1120,267,1280,245,1360,234.7L1440,224L1440,320L0,320Z" />
    </svg>
    {children}
  </main>;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { language } = useUiLanguage();
  const publicDemo = usePublicDemo();
  const english = language === "en";
  const publicRoute = pathname === "/product" || pathname === "/privacy" || pathname === "/terms";
  const [state, setState] = useState<GateState>("checking");
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const loginInFlight = useRef(false);

  const checkSession = useCallback(async () => {
    if (publicRoute) return;
    setState("checking");
    setMessage(null);
    try {
      const session = await apiRequest<SessionPayload>("/api/auth/me");
      publicDemo.setDemoMode(session.demoMode === true);
      if (session.demoMode === true) await publicDemo.refreshStatus();
      setSessionExpired(false);
      setState("authenticated");
      return;
    } catch (error) {
      if (!(error instanceof ReadyworkApiError) || error.status !== 401) {
        setMessage(errorMessage(error));
        setState("unavailable");
        return;
      }
    }
    try {
      const nextConfig = await apiRequest<AuthConfig>("/api/auth/config");
      setConfig(nextConfig);
      publicDemo.setDemoMode(nextConfig.demoMode === true);
      setState("unauthenticated");
    } catch (error) {
      setMessage(errorMessage(error));
      setState("unavailable");
    }
  }, [publicDemo.refreshStatus, publicDemo.setDemoMode, publicRoute]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  useEffect(() => {
    const requireAuthentication = (event: Event) => {
      if (publicRoute) return;
      const reason = event instanceof CustomEvent
        ? (event.detail as { reason?: ReadyworkAuthRequiredReason } | null)?.reason
        : undefined;
      setSessionExpired(reason !== "signed_out");
      setPassword("");
      setMessage(null);
      setState("unauthenticated");
      void apiRequest<AuthConfig>("/api/auth/config").then((next) => {
        setConfig(next);
        publicDemo.setDemoMode(next.demoMode === true);
      }).catch(() => setConfig(null));
    };
    window.addEventListener(READYWORK_AUTH_REQUIRED_EVENT, requireAuthentication);
    return () => window.removeEventListener(READYWORK_AUTH_REQUIRED_EVENT, requireAuthentication);
  }, [publicDemo.setDemoMode, publicRoute]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submittedUsername = String(form.get("username") ?? "").trim();
    const submittedPassword = String(form.get("password") ?? "");
    if (!submittedUsername || !submittedPassword || loginInFlight.current || !config?.passwordLogin) return;
    loginInFlight.current = true;
    setSubmitting(true);
    setMessage(null);
    try {
      await apiRequest<SessionPayload>("/api/auth/login", {
        method: "POST",
        body: { username: submittedUsername, password: submittedPassword },
      });
      const session = await apiRequest<SessionPayload>("/api/auth/me");
      publicDemo.setDemoMode(session.demoMode === true);
      setPassword("");
      setSessionExpired(false);
      setState("authenticated");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      loginInFlight.current = false;
      setSubmitting(false);
    }
  }

  async function enterPublicDemo() {
    if (loginInFlight.current || config?.mode !== "public_demo") return;
    loginInFlight.current = true;
    setSubmitting(true);
    setMessage(null);
    try {
      await apiRequest<SessionPayload>("/api/auth/public-demo", { method: "POST" });
      const session = await apiRequest<SessionPayload>("/api/auth/me");
      publicDemo.setDemoMode(session.demoMode === true);
      await publicDemo.refreshStatus();
      setSessionExpired(false);
      setState("authenticated");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      loginInFlight.current = false;
      setSubmitting(false);
    }
  }

  if (publicRoute || state === "authenticated") return children;

  if (state === "checking") {
    return <AuthBackdrop><div className="relative z-10 flex flex-col items-center text-center" aria-busy="true">
      <ReadyworkMark loading />
      <div className="mt-4 text-sm font-semibold text-[#273248]">正在验证安全会话</div>
      <div className="mt-1 text-xs text-[#8d96a5]">采购数据加载前先确认身份和租户权限</div>
    </div></AuthBackdrop>;
  }

  return <AuthBackdrop>
    <section className="relative z-10 w-full max-w-[620px]">
      <div className="mb-9 flex items-center justify-center gap-3.5">
        <ReadyworkMark />
        <span className="text-[30px] font-bold tracking-[-0.02em] text-[#0f1729] sm:text-[40px]">SupplySentry</span>
      </div>
      <div className="mb-9 text-center">
        <h1 className="text-[30px] font-bold tracking-[-0.02em] text-[#0f1729]">欢迎回来</h1>
        <p className="mt-1.5 text-[15px] text-[#65758b]">登录以访问 Readywork 采购执行工作区</p>
      </div>

      {state === "unavailable" ? <div className="rounded-3xl border border-[#eef2f6] bg-white p-7 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:p-9">
          <div className="text-sm font-semibold text-[#273248]">暂时无法验证登录服务</div>
          <div className="mt-2 text-xs leading-6 text-[#7f8998]">不会降级为匿名管理员，也不会展示缓存采购数据。</div>
          <button type="button" onClick={() => void checkSession()} className="mt-6 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-[#2563eb] text-[15px] font-semibold text-white shadow-[0_8px_20px_-8px_rgba(37,99,235,0.6)] hover:bg-[#1d4ed8]">重新检查<ArrowRight className="size-4" /></button>
        </div> : config?.passwordLogin ? <form onSubmit={(event) => void submit(event)} className="rounded-3xl border border-[#eef2f6] bg-white p-7 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:p-9">
          {sessionExpired && <div role="alert" className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">安全会话已过期。重新登录后会回到当前工作区，未提交的外部动作不会自动执行。</div>}
          {message && <div role="alert" className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700">{message}</div>}
          <label className="block">
            <span className="mb-2 block text-[14px] font-semibold text-[#0f1729]">用户名</span>
            <span className="relative block"><Mail className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-[#65758b]/70" /><input value={username} onChange={(event) => setUsername(event.target.value)} name="username" autoComplete="username" required className="h-[52px] w-full rounded-2xl border border-[#eef2f6] bg-white pl-12 pr-4 text-[15px] text-[#0f1729] shadow-[0_1px_2px_rgba(16,24,40,0.05)] outline-none transition placeholder:text-[#65758b]/60 focus:border-blue-400 focus:ring-4 focus:ring-blue-100/60" placeholder="输入用户名" /></span>
          </label>
          <label className="mt-6 block">
            <span className="mb-2 block text-[14px] font-semibold text-[#0f1729]">密码</span>
            <span className="relative block"><Lock className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-[#65758b]/70" /><input value={password} onChange={(event) => setPassword(event.target.value)} name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required className="h-[52px] w-full rounded-2xl border border-[#eef2f6] bg-white pl-12 pr-12 text-[15px] text-[#0f1729] shadow-[0_1px_2px_rgba(16,24,40,0.05)] outline-none transition placeholder:text-[#65758b]/60 focus:border-blue-400 focus:ring-4 focus:ring-blue-100/60" placeholder="输入密码" /><button type="button" aria-label={showPassword ? "隐藏密码" : "显示密码"} onClick={() => setShowPassword((current) => !current)} className="absolute right-3 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-xl text-[#65758b]/70 transition hover:bg-slate-100 hover:text-[#0f1729]">{showPassword ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}</button></span>
          </label>
          <button type="submit" disabled={submitting} className="mt-8 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-[#2563eb] text-[15px] font-semibold text-white shadow-[0_8px_20px_-8px_rgba(37,99,235,0.6)] transition hover:bg-[#1d4ed8] hover:shadow-[0_12px_28px_-8px_rgba(37,99,235,0.7)] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50">{submitting ? <><Loader2 className="size-4 animate-spin" />正在登录</> : "登录"}</button>
        </form> : config?.mode === "public_demo" ? <div className="rounded-3xl border border-amber-200 bg-white p-7 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:p-9">
          <div className="text-sm font-semibold text-[#273248]">{english ? "Public demo workspace" : "公开演示工作区"}</div>
          <div className="mt-2 text-xs leading-6 text-[#7f8998]">{english ? "Explore the complete procurement workflow with fictional suppliers and orders. Changes are writable and reset automatically." : "使用虚构供应商和订单体验完整采购流程。操作可写入，数据会定时重置。"}</div>
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900">{english ? "Synthetic data only. Uploads, credentials, and all external delivery are disabled." : "仅使用合成数据。上传、凭据配置和所有对外发送均已禁用。"}</div>
          {message && <div role="alert" className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-700">{message}</div>}
          <button type="button" onClick={() => void enterPublicDemo()} disabled={submitting} className="mt-6 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-[#2563eb] text-[15px] font-semibold text-white shadow-[0_8px_20px_-8px_rgba(37,99,235,0.6)] transition hover:bg-[#1d4ed8] disabled:cursor-not-allowed disabled:opacity-50">{submitting ? <Loader2 className="size-4 animate-spin" /> : null}{english ? "Enter public demo" : "进入公开演示"}<ArrowRight className="size-4" /></button>
        </div> : <div className="rounded-3xl border border-[#eef2f6] bg-white p-7 shadow-[0_1px_3px_rgba(16,24,40,0.04)] sm:p-9">
          <div className="text-sm font-semibold text-[#273248]">企业身份提供方尚未接入</div>
          <div className="mt-2 text-xs leading-6 text-[#7f8998]">生产环境不会启用内置账户。请配置企业 SSO；本机验收可仅对当前 API 进程显式开启演示认证。</div>
          <button type="button" onClick={() => void checkSession()} className="mt-6 flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl border border-[#eef2f6] bg-white text-[15px] font-semibold text-[#465166] hover:bg-[#f7f9fb]">重新检查</button>
        </div>}
    </section>
  </AuthBackdrop>;
}
