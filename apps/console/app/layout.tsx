import type { Metadata } from "next";
import { AuthGate } from "@/features/auth/auth-gate";
import { ChineseUiLocalization } from "@/features/localization/chinese-ui-localization";
import "./globals.css";

export const metadata: Metadata = {
  title: "Readywork — 采购执行工作区",
  description: "从供应商确认、生产、交付直至最终收货，全程跟踪采购订单。",
  icons: { icon: "/readywork/readywork-mark.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body><ChineseUiLocalization /><AuthGate>{children}</AuthGate></body>
    </html>
  );
}
