import type { Metadata } from "next";
import { AuthGate } from "@/features/auth/auth-gate";
import { UiLanguageProvider } from "@/features/localization/ui-language";
import "./globals.css";

export const metadata: Metadata = {
  title: "SupplySentry — 采购执行工作区",
  description: "从供应商确认、生产、交付直至最终收货，全程跟踪采购订单。",
  icons: { icon: "/readywork/readywork-mark.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><UiLanguageProvider><AuthGate>{children}</AuthGate></UiLanguageProvider></body>
    </html>
  );
}
