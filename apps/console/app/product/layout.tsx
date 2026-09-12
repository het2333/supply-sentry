import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Readywork 采购执行｜让每张采购订单按计划推进",
  description: "受监督的 AI 采购执行员，从采购订单发送跟踪到 ERP 收货，每项重大差异均由人工决策。",
};

export default function ProductLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
