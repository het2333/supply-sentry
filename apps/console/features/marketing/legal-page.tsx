/* eslint-disable @next/next/no-img-element */
import type { ReactNode } from "react";
import { LanguageSwitcher } from "@/features/localization/ui-language";

export type LegalSection = {
  id: string;
  title: string;
  content: ReactNode;
};

export function LegalPage({
  title,
  summary,
  effectiveDate,
  lastUpdated,
  sections,
}: {
  title: string;
  summary: string;
  effectiveDate: string;
  lastUpdated: string;
  sections: LegalSection[];
}) {
  return <main className="min-w-[1180px] overflow-x-clip bg-[#fafbfd] font-sans text-[#0b1220]">
    <header className="sticky top-0 z-50 border-b border-[#e8ecf2] bg-[#fafbfd]/95 backdrop-blur-xl">
      <div className="relative flex h-16 w-full items-center px-8">
        <a href="/product" aria-label="Readywork 首页"><img src="/readywork/readywork-mark.svg" alt="Readywork" width={196} height={40} className="h-6 w-auto" /></a>
        <nav aria-label="产品导航" className="absolute left-1/2 flex -translate-x-1/2 items-center gap-8 text-[13px] font-medium text-[#46536b]">
          <a href="/product#solution" className="transition hover:text-[#0b1220]">产品</a>
          <a href="/product#how-it-works" className="transition hover:text-[#0b1220]">工作原理</a>
          <a href="/product#risk-visibility" className="transition hover:text-[#0b1220]">风险洞察</a>
          <a href="/product#faq" className="transition hover:text-[#0b1220]">常见问题</a>
        </nav>
        <a href="/product#demo" className="ml-auto inline-flex h-8 items-center rounded-[10px] bg-[#0b1220] px-3 text-[13px] font-medium text-[#fafbfd]">申请演示</a>
        <LanguageSwitcher className="ml-3" />
      </div>
    </header>

    <section className="border-b border-[#e5eaf1] bg-white px-8 pb-16 pt-[76px]">
      <div className="mx-auto max-w-[1160px]">
        <div className="text-[11px] font-semibold uppercase tracking-[0.17em] text-blue-600">法律信息</div>
        <h1 className="mt-5 max-w-[900px] text-[56px] font-semibold leading-[1.05] tracking-[-0.045em]">{title}</h1>
        <p className="mt-5 max-w-[760px] text-[17px] leading-7 text-[#68758c]">{summary}</p>
        <p className="mt-5 text-[12px] text-[#8490a3]"><strong className="font-semibold text-[#526079]">生效日期</strong> {effectiveDate}<span className="px-2">·</span><strong className="font-semibold text-[#526079]">最后更新</strong> {lastUpdated}</p>
      </div>
    </section>

    <section className="px-8 py-16">
      <div className="mx-auto grid max-w-[1160px] grid-cols-[280px_minmax(0,1fr)] items-start gap-20">
        <aside className="sticky top-24 rounded-2xl border border-[#e1e7ef] bg-white p-5 shadow-[0_18px_50px_-42px_rgba(15,27,51,.3)]">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8b95a5]">本页内容</div>
          <nav aria-label="本页内容" className="mt-4 space-y-1">
            {sections.map((section, index) => <a key={section.id} href={`#${section.id}`} className="grid grid-cols-[24px_1fr] gap-2 rounded-xl px-2.5 py-2 text-[12px] leading-5 text-[#66738a] transition hover:bg-[#f3f6fa] hover:text-[#26344d]"><span className="font-mono text-[10px] text-[#9aa3b1]">{index + 1}</span><span>{section.title}</span></a>)}
          </nav>
        </aside>

        <article className="min-w-0">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-[12px] leading-6 text-amber-900">
            <strong>预发布声明。</strong>本页记录当前部署已经实现的行为。运营法律实体、官方联系人、数据保留期限、分处理者、适用法律和商业合同条款均须在商业上线前获批。本页不构成法律建议，也不能替代已签署的客户协议。
          </div>
          <div className="mt-10 divide-y divide-[#e5eaf1]">
            {sections.map((section, index) => <section key={section.id} id={section.id} className="scroll-mt-24 py-10 first:pt-0">
              <h2 className="text-[27px] font-semibold leading-tight tracking-[-0.025em]">{index + 1}. {section.title}</h2>
              <div className="legal-copy mt-5 space-y-4 text-[14px] leading-7 text-[#59677e]">{section.content}</div>
            </section>)}
          </div>
        </article>
      </div>
    </section>

    <footer className="border-t border-[#e3e8ef] bg-white px-8">
      <div className="mx-auto flex max-w-[1160px] items-center justify-between py-8 text-[11px] text-[#7c8799]">
        <span>Readywork 采购执行 · 预发布</span>
        <span className="flex items-center gap-5"><a href="/privacy" className="hover:text-[#26344d]">隐私政策</a><a href="/terms" className="hover:text-[#26344d]">使用条款</a><a href="/product" className="hover:text-[#26344d]">产品</a></span>
      </div>
    </footer>
  </main>;
}
