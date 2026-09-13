"use client";

import { FlaskConical, ShieldCheck } from "lucide-react";
import { useUiLanguage } from "@/features/localization/ui-language";
import { usePublicDemo } from "./public-demo-context";

export function PublicDemoBanner() {
  const { language } = useUiLanguage();
  const demo = usePublicDemo();
  if (!demo.demoMode) return null;
  const english = language === "en";
  return <div data-public-demo-banner className="fixed inset-x-0 top-0 z-[100] flex h-9 items-center justify-center gap-2 border-b border-amber-300 bg-amber-50 px-3 text-center text-[11px] font-semibold text-amber-950 shadow-sm sm:text-xs">
    <FlaskConical className="size-3.5 shrink-0" />
    <span>{english
      ? "Public demo · synthetic data · external delivery disabled"
      : "公开演示 · 合成数据 · 已禁用对外发送"}</span>
    {demo.generation !== null && <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-white/80 px-2 py-0.5 font-mono text-[10px]"><ShieldCheck className="size-3" />{english ? `Generation ${demo.generation}` : `第 ${demo.generation} 代`}</span>}
    {demo.resetNotice && <span role="status" className="hidden rounded-md bg-amber-100 px-2 py-0.5 font-medium lg:inline">{english
      ? "Public demo data was reset; this view has been refreshed"
      : "公开演示数据已重置，页面已刷新"}</span>}
  </div>;
}

export function PublicDemoFrame({ children }: { children: React.ReactNode }) {
  const { demoMode } = usePublicDemo();
  return <><PublicDemoBanner /><div className={demoMode ? "pt-9" : undefined}>{children}</div></>;
}
