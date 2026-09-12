/* eslint-disable @next/next/no-img-element */
import {
  ArrowRight,
  Check,
  ChevronDown,
  UserRound,
} from "lucide-react";
import { GeistSans } from "geist/font/sans";
import { ReadyworkProductVisual } from "@/features/marketing/readywork-product-visuals";
import { DemoRequestForm } from "./demo-request-form";

const stages = [
  { title: "采购订单已发送", text: "采购订单已创建并发送给供应商。" },
  { title: "供应商承诺", text: "供应商确认订单并承诺交付。" },
  { title: "履约／生产", text: "生产正在进行；持续跟踪进度直至货物就绪。" },
  { title: "发运／在途", text: "货物已经发运，正在运往目的地。" },
  { title: "交付／收货", text: "完成货物接收，并与 ERP 收货单交叉核验。" },
];

const manualChannels = [
  { kind: "email", label: "催办", alert: true },
  { kind: "phone", label: "通话记录", alert: false },
  { kind: "excel", label: "跟踪表", alert: false },
  { kind: "whatsapp", label: "消息", alert: true },
  { kind: "email", label: "供应商回复", alert: false },
  { kind: "wechat", label: "对话", alert: false },
] as const;

const toolChips = ["SAP", "QuickBooks", "Gmail", "Outlook", "Office 365", "WhatsApp", "WeChat"] as const;

const faqs = [
  ["Readywork 会取代我的采购团队吗？", ["不会。Readywork 负责受监督的协调工作，重大决策、供应商关系和审批权限仍由您的团队掌握。"]],
  ["Readywork 如何与 ERP 协同？", ["Readywork 在采购订单发送后管理采购执行，并补充您现有的交易系统。", "它催办供应商、跟踪已核验进度并暴露缺失证据，而不会成为第二套 ERP。"]],
  ["供应商会看到什么身份？", ["Readywork 只使用为贵组织配置的具名专业采购身份进行沟通。如果该身份尚未配置并核验，外部通信会保持阻断。"]],
  ["开始使用前必须连接 ERP 吗？", ["不必。Readywork 可以从已批准的邮箱和已核验采购订单证据开始。您可在准备好后连接 ERP；两种模式使用同一条审计链。"]],
  ["上线需要多长时间？", ["身份、邮箱安全和审批策略核验后，纯邮件模式可以快速启动。ERP 集成时间取决于选定的系统和范围。"]],
  ["我的数据安全吗？", ["凭据会加密保存，入站文档须经过明确的安全门禁，关键操作均可审计。生产启用前还会复核部署专属的安全和数据驻留控制。"]],
  ["Readywork 检测到差异时会怎样？", ["Readywork 会将采购订单、供应商证据、策略和可执行选项一起提示给对应的内部负责人；重大决策仍由您的团队作出。"]],
] as const;

function Logo({ footer = false }: { footer?: boolean }) {
  return <img src="/readywork/readywork-mark.svg" alt="Readywork" width={196} height={40} className={footer ? "h-7 w-auto" : "h-6 w-auto"} />;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="text-[12px] font-semibold uppercase leading-[1.55] tracking-[0.12em] text-[#157f75]">{children}</span>;
}

function BrowserShot({ label, children, caption, className = "" }: { label: string; children: React.ReactNode; caption?: string; className?: string }) {
  return <figure className={className}>
    <div aria-label={label} className="overflow-hidden rounded-[20px] border border-[rgba(15,27,51,.14)] bg-[#fafbfd] shadow-[0_8px_16px_rgba(15,27,51,.08),0_24px_64px_rgba(15,27,51,.13)]">
      <div className="relative flex h-10 items-center border-b border-[rgba(15,27,51,.08)] bg-[#f3f6fa] px-4">
        <div className="flex gap-1.5" aria-hidden="true">
          {[0, 1, 2].map((dot) => <span key={dot} className="size-2.5 rounded-full bg-slate-300" />)}
        </div>
        <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-[14px] py-[3px] font-mono text-[11px] leading-[17.05px] text-[#6b7a93]">Readywork 采购执行</span>
      </div>
      {children}
    </div>
    {caption ? <figcaption className="mt-[14px] text-center text-[13px] text-[#6b7a93]">{caption}</figcaption> : null}
  </figure>;
}

function ProductFigure({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  return <figure className={className}>
    <div aria-label={label} className="overflow-hidden rounded-[14px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd] shadow-[0_4px_8px_rgba(15,27,51,.06),0_12px_32px_rgba(15,27,51,.09)]">
      {children}
    </div>
  </figure>;
}

function ManualChannelIcon({ kind, className = "size-[13px]" }: { kind: (typeof manualChannels)[number]["kind"]; className?: string }) {
  if (kind === "email") return <svg className={`block ${className}`} viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" fill="#4A6CF7" /><rect x="5.5" y="7.5" width="13" height="9.5" rx="1.4" fill="none" stroke="#fff" strokeWidth="1.6" /><path d="m5.8 8.6 6.2 4.4 6.2-4.4" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (kind === "phone") return <svg className={`block ${className}`} viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" fill="#0EA5E9" /><path d="M17.4 14.9v1.6a1.1 1.1 0 0 1-1.2 1.1 10.9 10.9 0 0 1-4.75-1.7 10.7 10.7 0 0 1-3.3-3.3A10.9 10.9 0 0 1 6.4 7.8a1.1 1.1 0 0 1 1.1-1.2h1.65a1.1 1.1 0 0 1 1.1.95c.07.53.2 1.05.38 1.55a1.1 1.1 0 0 1-.25 1.16l-.7.7a8.8 8.8 0 0 0 3.3 3.3l.7-.7a1.1 1.1 0 0 1 1.16-.25c.5.18 1.02.31 1.55.38a1.1 1.1 0 0 1 .95 1.11z" fill="#fff" /></svg>;
  if (kind === "excel") return <svg className={`block ${className}`} viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="3" width="19" height="18" rx="2.4" fill="#107C41" /><path d="M8 7.5h2.6l1.9 3.1 2-3.1H17l-3 4.5 3.1 4.5h-2.6l-2-3.2-2 3.2H7.9l3.1-4.5z" fill="#fff" /></svg>;
  if (kind === "whatsapp") return <svg className={`block ${className}`} viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#25D366" /><path d="M12 4.8a7.1 7.1 0 0 0-6.1 10.7L4.8 19.2l3.8-1a7.1 7.1 0 1 0 3.4-13.4z" fill="#fff" /><path d="M9.4 8.1c-.2-.4-.4-.4-.6-.4h-.5c-.2 0-.5.07-.7.33-.25.27-.93.9-.93 2.2 0 1.3.95 2.55 1.08 2.73.13.17 1.84 2.93 4.54 4 2.25.88 2.7.7 3.2.66.48-.04 1.56-.63 1.78-1.25.22-.6.22-1.13.15-1.24-.06-.11-.24-.18-.5-.31-.27-.13-1.57-.77-1.81-.86-.24-.09-.42-.13-.6.13-.17.27-.68.86-.83 1.03-.15.18-.31.2-.57.07-.27-.13-1.12-.41-2.13-1.31-.79-.7-1.32-1.57-1.47-1.83-.15-.27-.02-.41.11-.54.12-.12.27-.31.4-.47.13-.15.18-.26.27-.44.09-.18.04-.33-.02-.46-.07-.13-.58-1.42-.82-1.94z" fill="#25D366" /></svg>;
  return <svg className={`block ${className}`} viewBox="0 0 24 24" aria-hidden="true"><path d="M9.3 3.5C5.3 3.5 2 6.2 2 9.6c0 1.9 1 3.6 2.6 4.7l-.65 2 2.25-1.15c.66.19 1.36.3 2.1.32-.13-.44-.2-.9-.2-1.37 0-3.2 3.1-5.7 6.7-5.7h.44C14.6 5.6 12.2 3.5 9.3 3.5z" fill="#07C160" /><circle cx="6.9" cy="8.1" r="0.95" fill="#fff" /><circle cx="11.7" cy="8.1" r="0.95" fill="#fff" /><path d="M22 14.2c0-2.8-2.8-5.1-6.2-5.1s-6.2 2.3-6.2 5.1 2.8 5.1 6.2 5.1c.7 0 1.37-.1 2-.27L19.7 20l-.55-1.7A4.8 4.8 0 0 0 22 14.2z" fill="#95EC69" /><circle cx="13.8" cy="13.2" r="0.85" fill="#1F1F1F" opacity="0.75" /><circle cx="17.8" cy="13.2" r="0.85" fill="#1F1F1F" opacity="0.75" /></svg>;
}

function ToolIcon({ tool }: { tool: (typeof toolChips)[number] }) {
  if (tool === "SAP") return <svg className="block size-[23px]" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="sap-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#00AEEF" /><stop offset="1" stopColor="#0072BC" /></linearGradient></defs><path d="M1 5h22l-7.5 14H1z" fill="url(#sap-gradient)" /><text x="3.2" y="13.8" fontFamily="Arial, Helvetica, sans-serif" fontWeight="bold" fontStyle="italic" fontSize="8.4" fill="#fff" letterSpacing="0.2">SAP</text></svg>;
  if (tool === "QuickBooks") return <svg className="block size-[23px]" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#2CA01C" /><circle cx="9" cy="13.4" r="3.1" fill="none" stroke="#fff" strokeWidth="1.9" /><line x1="12.1" y1="13.4" x2="12.1" y2="19" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" /><circle cx="15" cy="10.6" r="3.1" fill="none" stroke="#fff" strokeWidth="1.9" /><line x1="11.9" y1="10.6" x2="11.9" y2="5" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" /></svg>;
  if (tool === "Gmail") return <svg className="block size-[23px]" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 19h3.6v-8.9L2 7.4z" fill="#4285F4" /><path d="M18.4 19H22V7.4l-3.6 2.7z" fill="#34A853" /><path d="M2 7.4l10 7.4 10-7.4V5.9a1.4 1.4 0 0 0-2.24-1.12L12 10.6 4.24 4.78A1.4 1.4 0 0 0 2 5.9z" fill="#EA4335" /><path d="M2 5.9a1.4 1.4 0 0 1 2.24-1.12L5.6 5.9v4.2L2 7.4z" fill="#FBBC04" /><path d="M18.4 5.9l1.36-1.12A1.4 1.4 0 0 1 22 5.9L18.4 10.1z" fill="#C5221F" /></svg>;
  if (tool === "Outlook") return <svg className="block size-[23px]" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 4h8.2c.44 0 .8.36.8.8v3L16 11z" fill="#1490DF" /><path d="M13 11h9v7.2c0 .44-.36.8-.8.8H13z" fill="#28A8EA" /><path d="M13 7.8L22 8v3.2l-9 3z" fill="#0078D4" /><rect x="2" y="4.5" width="13" height="15" rx="1.6" fill="#0F6CBD" /><circle cx="8.5" cy="12" r="4.1" fill="none" stroke="#fff" strokeWidth="1.9" /></svg>;
  if (tool === "Office 365") return <svg className="block size-[23px]" viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="2.5" width="9" height="9" fill="#F25022" /><rect x="12.5" y="2.5" width="9" height="9" fill="#7FBA00" /><rect x="2.5" y="12.5" width="9" height="9" fill="#00A4EF" /><rect x="12.5" y="12.5" width="9" height="9" fill="#FFB900" /></svg>;
  if (tool === "WhatsApp") return <ManualChannelIcon kind="whatsapp" className="size-[23px]" />;
  return <ManualChannelIcon kind="wechat" className="size-[23px]" />;
}

function ErpIcon() {
  return <svg className="block size-6" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="5" fill="#4F46E5" /><rect x="6" y="6" width="5.2" height="5.2" rx="1.2" fill="#fff" /><rect x="12.8" y="6" width="5.2" height="5.2" rx="1.2" fill="#fff" opacity="0.55" /><rect x="6" y="12.8" width="5.2" height="5.2" rx="1.2" fill="#fff" opacity="0.55" /><rect x="12.8" y="12.8" width="5.2" height="5.2" rx="1.2" fill="#A5B4FC" /></svg>;
}

export default function ProductPage() {
  return <main className={`${GeistSans.className} min-w-[1180px] overflow-x-clip bg-[#fafbfd] text-[15px] leading-[1.55] tracking-[-0.003em] text-[#0b1220]`} style={{ width: "calc(100% - 5px)" }}>
    <header className="sticky top-0 z-50 box-border h-16 border-b border-[rgba(15,27,51,.08)] bg-[#fafbfd]/95 backdrop-blur-xl">
      <div className="relative flex h-full w-full items-center px-8">
        <a href="#top" aria-label="Readywork 首页"><Logo /></a>
        <nav aria-label="产品导航" className="absolute left-1/2 flex -translate-x-1/2 items-center gap-7 text-[13.5px] font-medium leading-[20.925px] text-[#46536b]">
          <a href="#solution" className="transition hover:text-[#0b1220]">产品</a>
          <a href="#how-it-works" className="transition hover:text-[#0b1220]">工作原理</a>
          <a href="#risk-visibility" className="transition hover:text-[#0b1220]">风险洞察</a>
          <a href="#faq" className="transition hover:text-[#0b1220]">常见问题</a>
        </nav>
        <a href="#demo" className="ml-auto inline-flex h-8 items-center gap-2 rounded-[10px] border border-transparent bg-[#0b1220] px-3 text-[13px] font-medium tracking-[-0.005em] text-[#fafbfd]">申请演示<ArrowRight className="size-3.5" /></a>
      </div>
    </header>

    <section id="top" className="bg-[#fafbfd] px-8 pb-0 pt-[72px] text-center">
      <div className="mx-auto max-w-[1360px]">
        <h1 className="sr-only">Readywork 采购执行通过受监督的供应商催办、交付跟踪和基于证据的风险识别，让每张采购订单从发送到收货都按计划推进。</h1>
        <div className="mx-auto max-w-[880px]">
          <div><Eyebrow>采购执行 AI</Eyebrow></div>
          <p className="mb-[18px] mt-5 text-[80px] font-semibold leading-[1.03] tracking-[-0.035em]">让每张采购订单按计划推进。</p>
          <p className="mb-[22px] text-[32px] font-semibold leading-[1.35] tracking-[-0.02em] text-[#35445f]">从<span className="text-[#23806e]">采购订单发送</span>到<span className="text-[#23806e]">最终收货。</span></p>
          <p className="mx-auto mb-9 max-w-[680px] text-[19px] leading-[1.55] tracking-[-0.005em] text-[#536078]">Readywork 用 AI 催办供应商、跟踪交付并提前识别风险，帮助采购团队让每张采购订单按计划推进。</p>
          <div className="mb-16 flex h-12 items-center justify-center gap-3">
            <a href="#demo" className="inline-flex h-12 items-center gap-2 rounded-[10px] border border-transparent bg-[#0b1220] px-[22px] text-[15px] font-medium tracking-[-0.005em] text-[#fafbfd]">申请演示<ArrowRight className="size-4" /></a>
            <a href="#solution" className="inline-flex h-12 items-center gap-2 rounded-[10px] border border-[rgba(15,27,51,.14)] bg-[#fafbfd] px-[22px] text-[15px] font-medium tracking-[-0.005em] text-[#0b1220]">查看产品概览</a>
          </div>
        </div>
        <div className="pb-24">
          <BrowserShot label="Readywork 采购执行总览" className="mx-auto max-w-[1000px]"><ReadyworkProductVisual kind="overview" /></BrowserShot>
        </div>
      </div>
    </section>

    <section className="border-t border-[rgba(15,27,51,.08)] bg-[#f3f6fa] px-8 py-12">
      <div className="mx-auto max-w-[1360px] text-center">
        <p className="mb-[22px] text-[14.5px] font-semibold uppercase leading-[22.475px] tracking-[.09em]">连接您已经使用的工具</p>
        <div className="flex items-center justify-center gap-[14px]">
          {toolChips.map((tool) => <span key={tool} className="inline-flex items-center gap-2.5 rounded-[10px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-5 py-3 text-[15px] font-semibold tracking-[.01em]">
            <ToolIcon tool={tool} />{tool}
          </span>)}
        </div>
      </div>
    </section>

    <section id="problem" className="scroll-mt-20 border-t border-[rgba(15,27,51,.08)] bg-[#f3f6fa] px-8 py-24">
      <div className="mx-auto max-w-[1360px]">
        <Eyebrow>问题</Eyebrow>
        <h2 className="mt-5 max-w-[980px] text-balance text-[52px] font-semibold leading-[1.08] tracking-[-0.03em]">采购订单发出后，团队仍要在分散的渠道中催办供应商，并用电子表格跟踪交付和风险<span className="text-[#66738a]">；规模扩大后，这套流程难以为继。</span></h2>
        <div className="mt-14 rounded-[20px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-9 py-10 shadow-[0_1px_2px_rgba(15,27,51,.04),0_2px_6px_rgba(15,27,51,.05)]">
          <div className="grid grid-cols-[minmax(0,5fr)_minmax(0,3fr)_minmax(0,5fr)] items-center">
            <div className="rounded-[14px] border border-[rgba(15,27,51,.14)] bg-[#f3f6fa] px-[22px] py-6">
              <span className="grid size-10 place-items-center rounded-[6px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd]"><ErpIcon /></span>
              <div className="mb-1.5 mt-4 text-[16px] font-semibold">您的 ERP</div>
              <div className="mb-[14px] font-mono text-[12.5px] text-[#66738a]">已核验的采购订单证据</div>
              <span className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 text-[12px] font-medium text-amber-800"><span className="size-1.5 rounded-full bg-amber-500" />需要证据</span>
              <p className="mt-4 text-[13px] leading-[1.5] text-[#66738a]">执行工作往往从这里离开系统。</p>
            </div>
            <svg viewBox="0 0 100 100" aria-hidden="true" className="h-[280px] w-full text-[rgba(15,27,51,.22)]" preserveAspectRatio="none">
              {[10, 30, 50, 70, 90].map((y) => <path key={y} d={`M 0 50 C 45 50, 55 ${y}, 100 ${y}`} fill="none" stroke="currentColor" strokeWidth="1" strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />)}
            </svg>
            <div className="flex flex-col gap-[14px]">{[
              ["email", "电子邮件", "等待来源事件", "bg-[#9aa5b5]"],
              ["whatsapp", "WhatsApp", "需要连接", "bg-[#9aa5b5]"],
              ["wechat", "微信", "尚未配置", "bg-[#9aa5b5]"],
              ["phone", "电话", "人工证据", "bg-[#9aa5b5]"],
              ["excel", "电子表格", "需要核验", "bg-[#9aa5b5]"],
            ].map(([kind, label, detail, dotTone]) => <div key={label} className="flex items-center gap-3 rounded-[10px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-4 py-3 shadow-[0_1px_2px_rgba(15,27,51,.04)]">
              <span className="shrink-0"><ManualChannelIcon kind={kind as (typeof manualChannels)[number]["kind"]} className="size-[19px]" /></span>
              <div className="min-w-0"><div className="text-[13.5px] font-semibold">{label}</div><div className="truncate font-mono text-[11px] text-[#66738a]">{detail}</div></div>
              <span className={`ml-auto size-[7px] shrink-0 rounded-full ${dotTone}`} />
            </div>)}</div>
          </div>
          <p className="mt-7 border-t border-[rgba(15,27,51,.08)] pt-5 text-center text-[14px] leading-[21.7px] text-[#46536b]">供应商催办、交付跟踪和问题解决，都要靠人工在分散渠道之间协调。</p>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-5">{[["追溯", "将供应商协调追溯到采购订单及其证据"], ["识别", "在错过到期日之前发现缺失确认和时间风险"], ["决策", "让重大差异继续由负有责任的采购负责人决策"]].map(([value, text]) => <article key={value} className="rounded-[14px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-7 py-8"><div className="mb-3 font-mono text-[44px] font-semibold leading-none tracking-[-.03em]">{value}</div><p className="text-[14px] leading-[1.5] text-[#46536b]">{text}</p></article>)}</div>
      </div>
    </section>

    <section id="gap" className="scroll-mt-20 border-t border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-8 py-24">
      <div className="mx-auto max-w-[1360px]">
        <Eyebrow>关键缺口</Eyebrow>
        <h2 className="mt-5 max-w-[760px] text-balance text-[52px] font-semibold leading-[1.08] tracking-[-0.03em]">采购订单逾期之前，风险信号其实已经出现。</h2>
        <div className="mt-14 grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-center gap-16">
          <div>
            <div className="grid grid-cols-2 gap-4">{[
              ["email", "电子邮件", "供应商承诺仍未核验。", true],
              ["clock", "尚未回复", "已超过配置的确认时限。", true],
              ["whatsapp", "WhatsApp", "数量证据与采购订单不一致。", false],
              ["email", "电子邮件", "依赖的审批仍在等待处理。", false],
            ].map(([kind, label, text, warning], index) => <blockquote key={`${label}-${index}`} className={`m-0 rounded-[10px] bg-[#fafbfd] px-[22px] py-5 shadow-[0_1px_2px_rgba(15,27,51,.04)] ${warning ? "border-l-[3px] border-l-[#c99765]" : "border border-[rgba(15,27,51,.08)]"}`}>
              <div className="mb-3 flex h-[18px] items-center gap-2">
                {kind === "clock" ? <span className="grid size-[18px] place-items-center rounded-[5px] bg-[#fbf2e8] text-[#c99765]"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg></span> : <ManualChannelIcon kind={kind as (typeof manualChannels)[number]["kind"]} className="size-[18px]" />}
                <span className="font-mono text-[11px] uppercase tracking-[.08em] text-[#46536b]">{label}</span>
              </div>
              <p className="text-[16.5px] font-medium leading-[1.4] tracking-[-.01em]">“{String(text)}”</p>
            </blockquote>)}</div>
            <p className="mt-7 max-w-[520px] text-[18px] leading-[1.55] text-[#46536b]">等到错过到期日时，<span className="font-medium text-[#0b1220]">风险信号早已出现。</span></p>
          </div>
          <div className="relative pb-14 pr-6">
            <BrowserShot label="Readywork 通知展示已持久化的执行事件"><ReadyworkProductVisual kind="notifications" /></BrowserShot>
            <ProductFigure label="Readywork 证据摘要" className="absolute bottom-0 right-0 w-[280px]"><div className="bg-white p-5"><div className="text-xs font-semibold text-slate-800">执行摘要</div><p className="mt-3 text-[11px] leading-5 text-slate-500">暂无持久化数据。核验来源事件后才会显示有证据支持的结论。</p></div></ProductFigure>
          </div>
        </div>
      </div>
    </section>

    <section id="solution" className="scroll-mt-20 bg-[#f3f6fa] px-8 py-24">
      <div className="mx-auto max-w-[1360px]">
        <Eyebrow>解决方案</Eyebrow>
        <h2 className="mb-6 mt-5 max-w-[1000px] text-balance text-[52px] font-semibold leading-[1.08] tracking-[-0.03em]">Readywork 用 AI 催办供应商、跟踪交付并提前识别风险，帮助采购团队让每张采购订单按计划推进。</h2>
        <p className="max-w-[720px] text-[18px] leading-[1.55] tracking-[-0.005em] text-[#536078]">在采购订单逾期前，知道哪些事项需要关注。</p>
        <BrowserShot label="Readywork 待审核的邮件草稿队列" caption="Readywork 起草催办，您的团队负责批准。" className="mx-auto mt-14 max-w-[1160px]"><ReadyworkProductVisual kind="drafted-emails" /></BrowserShot>
        <div className="mt-[72px] grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-center gap-16">
          <article className="flex items-start gap-4 rounded-2xl border border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-[26px] py-7">
            <svg width="40" height="40" viewBox="0 0 32 32" aria-hidden="true" className="block shrink-0">
              <rect width="32" height="32" rx="8" fill="#0F1B33" />
              <path d="M10.2 22.5v-13" stroke="#FFFFFF" strokeWidth="3.1" strokeLinecap="round" />
              <path d="M10.2 9.5l11.6 13" stroke="#2EC4B6" strokeWidth="3.1" strokeLinecap="round" />
              <path d="M21.8 22.5v-13" stroke="#FFFFFF" strokeWidth="3.1" strokeLinecap="round" />
            </svg>
            <div>
              <p className="mb-2 text-[17px] font-medium leading-[1.45] tracking-[-0.01em]">不是系统通知，而是供应商认识的采购专业身份。</p>
              <p className="text-[14.5px] leading-[1.6] text-[#536078]">Readywork 只通过已核验的具名身份和已批准渠道沟通。每条获接受的消息都与采购订单和连接器回执保持关联。</p>
            </div>
          </article>
          <BrowserShot label="带执行阶段和证据门禁的 Readywork 总览"><ReadyworkProductVisual kind="overview" /></BrowserShot>
        </div>
      </div>
    </section>

    <section id="how-it-works" className="scroll-mt-20 bg-[#f3f6fa] px-8 py-24">
      <div className="mx-auto max-w-[1360px]">
        <div>
          <Eyebrow>工作原理</Eyebrow>
          <h2 className="mt-5 max-w-[860px] text-[52px] font-semibold leading-[1.08] tracking-[-0.03em]">每张采购订单都通过五个阶段管理，<span className="text-[#66738a]">从采购订单发送到 ERP 收货。</span></h2>
        </div>

        <div className="mt-14 rounded-[20px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-9 pb-7 pt-10 shadow-[0_1px_2px_rgba(15,27,51,.04),0_2px_6px_rgba(15,27,51,.05)]">
          <ol className="grid grid-cols-5">
            {stages.map((stage, index) => <li key={stage.title} className="relative flex min-w-0 flex-col pr-[14px]">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#2ec4b6] text-[11.5px] font-semibold leading-[17.825px] text-white">{index + 1}</span>
              {index < stages.length - 1 ? <span aria-hidden="true" className="absolute left-10 right-3 top-[13px] h-0.5 bg-[rgba(15,27,51,.14)]" /> : null}
              <div className="mt-3 max-w-[220px]">
                <h3 className="mb-1.5 text-[15.5px] font-semibold leading-[24.025px]">{stage.title}</h3>
                <p className="text-[13.5px] leading-[20.925px] text-[#46536b]">{stage.text}</p>
              </div>
            </li>)}
          </ol>
        </div>

        <div className="mt-16 grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-center gap-16">
          <div>
            <h3 className="mb-5 max-w-[420px] text-[24px] font-semibold leading-[30px] tracking-[-0.02em]">真实采购订单中的执行方式</h3>
            <ul className="flex flex-col gap-4">
              {["每个阶段都有 SLA 目标和宽限期；供应商超时未回复时自动升级。", "通过电子邮件和 WhatsApp 持续催办直到阶段确认，每条消息都记录到对应采购订单。", "物流交接前核验进口单据，交付时再与 ERP 收货单交叉核对。"].map((item) => <li key={item} className="flex gap-3">
                <Check strokeWidth={1.5} className="mt-0.5 size-[18px] shrink-0 text-[#157f75]" />
                <span className="text-[15px] leading-6 text-[#46536b]">{item}</span>
              </li>)}
            </ul>
          </div>
          <figure className="mx-auto w-full max-w-[560px]">
            <div className="overflow-hidden rounded-[14px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd] shadow-[0_4px_8px_rgba(15,27,51,.06),0_12px_32px_rgba(15,27,51,.09)]">
              <ReadyworkProductVisual kind="po-timeline" />
            </div>
            <figcaption className="mt-[14px] text-center text-[13px] leading-[20.15px] text-[#6b7a93]">只有持久化已核验的阶段证据后，生命周期视图才会显示内容。</figcaption>
          </figure>
        </div>
      </div>
    </section>

    <section id="risk-visibility" className="scroll-mt-20 border-t border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-8 py-24">
      <div className="mx-auto max-w-[1360px]">
        <div className="mb-14">
          <Eyebrow>风险洞察</Eyebrow>
          <h2 className="mb-6 mt-5 max-w-[880px] text-balance text-[52px] font-semibold leading-[1.08] tracking-[-0.03em]">在错过交付前看清采购执行风险<span className="text-[#66738a]">发生在哪里。</span></h2>
          <p className="max-w-[720px] text-[18px] leading-[1.55] tracking-[-0.005em] text-[#46536b]">从逐单催办，转向统一管理整个采购组合的执行风险。</p>
        </div>
        <BrowserShot label="Readywork 风险看板：不使用示例业务指标展示证据覆盖率和风险状态" className="mx-auto max-w-[1160px]"><ReadyworkProductVisual kind="risk-dashboard" /></BrowserShot>
      </div>
    </section>

    <section id="value" className="scroll-mt-20 border-t border-[rgba(15,27,51,.08)] bg-[#f3f6fa] px-8 py-24">
      <div className="mx-auto max-w-[1360px]">
        <div className="mb-14">
          <Eyebrow>客户价值</Eyebrow>
          <h2 className="mb-6 mt-5 max-w-[820px] text-balance text-[52px] font-semibold leading-[1.08] tracking-[-0.03em]">扩大采购执行能力<span className="text-[#66738a]">，而不是协调工作量。</span></h2>
          <p className="max-w-[720px] text-[18px] leading-[1.55] tracking-[-0.005em] text-[#46536b]">同一支团队可以更有把握地管理更多采购订单。</p>
        </div>

        <div className="overflow-hidden rounded-[20px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd] shadow-[0_1px_2px_rgba(15,27,51,.04),0_2px_6px_rgba(15,27,51,.05)]">
          <div className="grid h-[432px] grid-cols-[minmax(0,1fr)_44px_minmax(0,1fr)] items-center gap-6 px-8 py-9">
            <article className="relative h-[360px] min-w-0 overflow-hidden rounded-[14px] border border-[rgba(15,27,51,.08)] bg-[#f3f6fa] px-6 pb-[22px] pt-[26px] text-center">
              <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute bottom-[24%] left-[8%] right-[8%] top-[34%] h-[42%] w-[84%] opacity-50">
                {["M 8 10 C 30 90, 60 0, 92 70", "M 50 0 C 20 60, 85 30, 55 95", "M 90 5 C 55 45, 40 90, 10 60", "M 15 85 C 45 30, 70 80, 88 25"].map((path) => <path key={path} d={path} fill="none" stroke="rgba(15,27,51,.14)" strokeWidth="0.8" strokeDasharray="2.5 3.5" vectorEffect="non-scaling-stroke" />)}
              </svg>
              <div className="relative mb-[18px] text-[12px] font-semibold uppercase tracking-[.1em] text-[#66738a]">人工协调</div>
              <div className="relative flex justify-center gap-2.5">{[0, 1, 2].map((item) => <span key={item} className="grid size-10 place-items-center rounded-full border border-[rgba(15,27,51,.14)] bg-[#fafbfd] text-[#46536b] shadow-[0_1px_2px_rgba(15,27,51,.05)]"><UserRound className="size-[17px]" strokeWidth={1.5} /></span>)}</div>
              <div className="relative mt-5 flex flex-wrap justify-center gap-x-1.5 gap-y-2.5">{manualChannels.map((item) => <span key={item.label} className="inline-flex items-center gap-1.5 rounded-[6px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-[9px] py-[5px] font-mono text-[11px] text-[#46536b] shadow-[0_1px_2px_rgba(15,27,51,.05)]"><ManualChannelIcon kind={item.kind} />{item.label}{item.alert ? <span className="size-1.5 shrink-0 rounded-full bg-[#dc4c4c]" /> : null}</span>)}</div>
              <p className="relative mt-[18px] text-center text-[13px] leading-[1.5] text-[#66738a]">每张采购订单都要在各个渠道里人工催办。</p>
            </article>

            <div aria-hidden="true" className="grid place-items-center"><span className="grid size-11 place-items-center rounded-full border border-[rgba(15,27,51,.14)] bg-[#fafbfd] text-[#157f75] shadow-[0_1px_2px_rgba(15,27,51,.04),0_2px_6px_rgba(15,27,51,.05)]"><ArrowRight className="size-5" strokeWidth={2} /></span></div>

            <article className="h-[360px] min-w-0 rounded-[14px] border border-[rgba(46,196,182,.35)] bg-[linear-gradient(165deg,#e4f6f4,#f2fbfa_65%)] px-6 pb-[22px] pt-[26px]">
              <div className="mb-[18px] text-center text-[12px] font-semibold uppercase tracking-[.1em] text-[#157f75]">AI 辅助执行</div>
              <div className="flex justify-center gap-2.5">{[0, 1, 2].map((item) => <span key={item} className="grid size-10 place-items-center rounded-full border border-[rgba(15,27,51,.14)] bg-[#fafbfd] text-[#46536b] shadow-[0_0_0_3px_rgba(46,196,182,.18)]"><UserRound className="size-[17px]" strokeWidth={1.5} /></span>)}</div>
              <div className="mb-4 mt-[14px] flex justify-center"><span className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-[#fafbfd] py-[5px] pl-1.5 pr-[14px] text-[12.5px] font-semibold shadow-[0_1px_2px_rgba(15,27,51,.04),0_2px_6px_rgba(15,27,51,.05)]"><span className="grid size-6 place-items-center rounded-md bg-[#0f172a] text-[11px] font-semibold text-white">R</span>Readywork</span></div>
              <div className="flex flex-col gap-[7px]">{[["来源证据", "订单已发送"], ["供应商回复", "承诺"], ["生产证据", "履约"], ["连接器回执", "交付／收货"]].map(([evidence, stage]) => <div key={evidence} className="flex items-center gap-2.5 rounded-[6px] border border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-3 py-2"><span className="font-mono text-[12px] font-medium">{evidence}</span><span className="truncate whitespace-nowrap border-l border-[rgba(15,27,51,.08)] pl-2.5 text-[11px] text-[#66738a]">{stage}</span><span className="ml-auto inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] text-[#46536b]"><span className="size-1.5 rounded-full bg-amber-500" />必需</span></div>)}</div>
            </article>
          </div>
          <div className="border-t border-[rgba(15,27,51,.08)] bg-[#f3f6fa] px-6 py-[18px] text-center text-[15.5px] font-semibold leading-[24.025px] tracking-[-0.01em]">同一支团队，更大的执行能力。</div>
        </div>

        <ProductFigure label="需要持久化证据的 Readywork 采购路线" className="mx-auto mt-16 max-w-[1160px]"><div className="grid grid-cols-3 gap-4 bg-white p-6">{["已核验来源", "已分配路线", "当前回执"].map((item) => <div key={item} className="rounded-xl border border-slate-200 bg-slate-50 p-5"><div className="text-xs font-semibold text-slate-700">{item}</div><p className="mt-3 text-[11px] text-slate-500">暂无持久化数据</p></div>)}</div></ProductFigure>
        <div className="mx-auto mt-5 grid max-w-[1160px] grid-cols-2 gap-5">
          <ProductFigure label="本地采购路线"><ReadyworkProductVisual kind="route-local" /></ProductFigure>
          <ProductFigure label="进口采购路线"><ReadyworkProductVisual kind="route-import" /></ProductFigure>
        </div>
      </div>
    </section>

    <section id="why-us" className="scroll-mt-20 border-t border-[rgba(15,27,51,.08)] bg-[#f3f6fa] px-8 py-14">
      <div className="mx-auto max-w-[880px] text-center">
        <Eyebrow>为什么选择 Readywork</Eyebrow>
        <p className="mt-4 text-balance text-[26px] font-medium leading-[1.4] tracking-[-0.02em]">受监督的采购执行，将租户隔离、证据门禁、人工审批和连接器回执融入每一项重要操作。</p>
      </div>
    </section>

    <section id="faq" className="scroll-mt-20 border-t border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-8 py-24">
      <div className="mx-auto max-w-[880px]">
        <Eyebrow>常见问题</Eyebrow>
        <h2 className="mb-12 mt-5 text-balance text-[52px] font-semibold leading-[1.08] tracking-[-0.03em]">您可能关心的问题</h2>
        <div>{faqs.map(([question, answers]) => <details key={question} className="group border-b border-[rgba(15,27,51,.08)]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-[22px] text-left [&::-webkit-details-marker]:hidden">
            <span className="text-[16px] font-medium leading-[20.5px] tracking-[-0.01em]">{question}</span>
            <ChevronDown strokeWidth={1.5} className="size-[18px] shrink-0 text-[#66738a] transition-transform duration-200 group-open:rotate-180" />
          </summary>
          <div className="flex max-w-[720px] flex-col gap-2.5 pb-[22px]">{answers.map((answer) => <p key={answer} className="text-[15px] leading-[1.6] text-[#46536b]">{answer}</p>)}</div>
        </details>)}</div>
      </div>
    </section>

    <section id="demo" className="scroll-mt-20 bg-[#0f1b33] px-8 py-24 text-[#e6ecf6]">
      <div className="mx-auto grid max-w-[1360px] grid-cols-[minmax(0,5fr)_minmax(0,6fr)] gap-16">
        <div>
          <div className="mb-8">
            <span className="text-[12px] font-semibold uppercase leading-[1.55] tracking-[0.12em] text-[#8fa1c0]">申请演示</span>
            <h2 className="mb-6 mt-5 max-w-[800px] text-balance text-[52px] font-semibold leading-[1.08] tracking-[-0.03em]">让 Readywork 开始推进您的采购订单。</h2>
            <p className="max-w-[720px] text-[18px] leading-[1.55] tracking-[-0.005em] text-[#8fa1c0]">从限定范围的试点开始。启用任何外部操作前，我们会先配置采购身份、邮箱安全、审批策略和执行路线。</p>
          </div>
          <p className="mb-10 max-w-[480px] border-t border-[rgba(230,236,246,.14)] pt-6 text-[14px] leading-[1.6] text-[#8fa1c0]">试点全程受监督。在所需身份、审批和连接器检查完成前，供应商通信和 ERP 写入会保持阻断。</p>
          <div className="flex flex-col gap-7">
            <div><div className="mb-2 text-[12px] font-semibold uppercase tracking-[.06em] text-[#8fa1c0]">试点边界</div><p className="text-[14px] leading-[1.6] text-[#e6ecf6]">选定的采购订单范围、供应商集合和执行路线。</p></div>
            <div><div className="mb-2 text-[12px] font-semibold uppercase tracking-[.06em] text-[#8fa1c0]">外部操作</div><p className="text-[14px] leading-[1.6] text-[#e6ecf6]">只有通过明确的生产验证后才会启用。</p></div>
            <p className="text-[14px] leading-[1.8] text-[#e6ecf6]">每份已接受的申请都会持久化并可审计。<br />此表单不会触发任何供应商或 ERP 操作。</p>
          </div>
        </div>

        <div className="overflow-hidden rounded-[14px] bg-[#fafbfd] text-[#0b1220] shadow-[0_8px_16px_rgba(15,27,51,.08),0_24px_64px_rgba(15,27,51,.13)]">
          <div aria-hidden="true" className="h-[5px] bg-gradient-to-r from-[#2ec4b6] to-[#4a6cf7]" />
          <div className="px-[30px] pb-8 pt-[30px]">
            <div className="mb-6">
              <div className="mb-2 flex items-center gap-3">
                <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true" className="block shrink-0"><rect width="32" height="32" rx="8" fill="#0F1B33" /><path d="M10.2 22.5v-13" stroke="#FFFFFF" strokeWidth="3.1" strokeLinecap="round" /><path d="M10.2 9.5l11.6 13" stroke="#2EC4B6" strokeWidth="3.1" strokeLinecap="round" /><path d="M21.8 22.5v-13" stroke="#FFFFFF" strokeWidth="3.1" strokeLinecap="round" /></svg>
                <h3 className="text-[19px] font-semibold tracking-[-0.015em]">从限定范围的试点开始</h3>
              </div>
              <p className="text-[13.5px] leading-[1.55] text-[#66738a]">请简要介绍您的采购运作，我们将围绕您的采购订单配置 Readywork。</p>
            </div>
            <DemoRequestForm />
          </div>
        </div>
      </div>
    </section>

    <footer className="border-t border-[rgba(15,27,51,.08)] bg-[#fafbfd] px-8 pb-10 pt-16">
      <div className="mx-auto mb-12 flex h-[227.75px] max-w-[1360px] items-center gap-10 border-b border-[rgba(15,27,51,.08)] pb-10">
        <div className="flex h-[186.75px] w-[180px] shrink-0 items-start">
          <div className="flex size-[180px] flex-col justify-between rounded-[6px] border border-[rgba(15,27,51,.14)] bg-[#0f1b33] p-5 text-[#e6ecf6] shadow-[0_4px_8px_rgba(15,27,51,.06),0_12px_32px_rgba(15,27,51,.09)]">
            <div className="text-[12px] font-semibold uppercase tracking-[.12em] text-[#8fa1c0]">Readywork</div>
            <div><div className="text-[52px] font-semibold leading-none tracking-[-.05em]">V1</div><div className="mt-2 text-[11px] font-semibold uppercase leading-[1.4] tracking-[.1em] text-[#2ec4b6]">采购执行员</div></div>
            <div className="border-t border-white/15 pt-3 text-[10px] uppercase tracking-[.08em] text-[#aebbd0]">证据支撑</div>
          </div>
        </div>
        <div className="max-w-[520px]">
          <div className="mb-2.5 text-[12px] font-medium uppercase tracking-[.12em] text-[#66738a]">产品标准</div>
          <p className="mb-2 text-[19px] font-semibold leading-[1.35] tracking-[-0.015em]">Readywork 采购执行 · V1</p>
          <p className="mb-[14px] text-[14px] leading-[1.6] text-[#66738a]">版本化工作流、受管控操作、真实连接器要求和租户隔离的业务数据。</p>
          <a href="#how-it-works" className="text-[14px] font-medium text-[#157f75]">查看执行模型 →</a>
        </div>
      </div>

      <div className="mx-auto grid min-h-[205.461px] max-w-[1360px] grid-cols-[1.4fr_1fr_1fr_1fr] gap-12">
        <div>
          <Logo footer />
          <p className="mt-4 max-w-[280px] text-[13px] leading-[1.6] text-[#66738a]">用于采购执行的 AI，从订单发送到 ERP 收货，持续催办供应商、跟踪交付并提前识别风险。</p>
          <div className="mt-5 text-[13px]"><a href="#demo" className="text-[#66738a]">申请限定范围的试点</a></div>
          <div className="mt-4"><a href="#how-it-works" className="inline-flex h-10 items-center gap-2 rounded-[6px] border border-[rgba(15,27,51,.14)] px-4 text-[13px] font-medium"><span className="grid size-[18px] place-items-center rounded bg-[#0f1b33] text-[10px] text-white">R</span>查看执行模型</a></div>
        </div>
        <div><div className="mb-4 text-[12px] font-medium uppercase tracking-[.12em] text-[#66738a]">产品</div><ul className="flex flex-col gap-2.5 text-[13.5px] text-[#46536b]"><li><a href="#solution">解决方案</a></li><li><a href="#how-it-works">工作原理</a></li><li><a href="#risk-visibility">风险洞察</a></li><li><a href="#faq">常见问题</a></li></ul></div>
        <div><div className="mb-4 text-[12px] font-medium uppercase tracking-[.12em] text-[#66738a]">公司</div><ul className="flex flex-col gap-2.5 text-[13.5px] text-[#46536b]"><li><a href="#why-us">为什么选择 Readywork</a></li><li><a href="#demo">申请演示</a></li></ul></div>
        <div><div className="mb-4 text-[12px] font-medium uppercase tracking-[.12em] text-[#66738a]">法律</div><ul className="flex flex-col gap-2.5 text-[13.5px] text-[#46536b]"><li><a href="/privacy">隐私政策</a></li><li><a href="/terms">使用条款</a></li></ul></div>
      </div>

      <div className="mx-auto mt-12 flex max-w-[1360px] gap-12 border-t border-[rgba(15,27,51,.08)] pt-6 text-[12px] text-[#6b7a93]"><span>桌面网页 · 1280×720 / 1440×900 / 1920×1080</span><span>采购执行员 · 预发布版</span></div>
      <div className="mx-auto mt-4 flex max-w-[1360px] justify-between font-mono text-[12px] text-[#6b7a93]"><span>© 2026 Readywork</span><span>v1.0.0</span></div>
    </footer>
  </main>;
}
