import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AiSupplierReplyAnalysis } from "../features/procurement/ai-supplier-reply-analysis.js";

test("AI 回信解析卡显示真实路线、生产、ASN 发运来源和部分更新状态", () => {
  const html = renderToStaticMarkup(<AiSupplierReplyAnalysis analysis={{
    status: "partially_applied",
    summary: "供应商已确认境内采购并完成发运",
    reason: "可验证事实已更新；其余区块需人工核验。",
    verifiedRoute: { value: "local", quote: "本订单为境内采购" },
    verifiedProductionLines: [{ poLineId: "line:1", quantity: 200, progressStatus: "ready_to_ship", completionPercent: 100, expectedReadyAt: "2026-09-08T00:00:00.000Z" }],
    verifiedShipment: { supplierReference: "ASN-001", carrier: "DHL", trackingNumber: "DHL-TRACK-001", estimatedArrivalAt: "2026-09-12T00:00:00.000Z", lines: [{ poLineId: "line:1", quantity: 200 }] },
    blockResults: { route: { status: "applied" }, production: { status: "applied" }, shipment: { status: "applied" }, confirmation: { status: "review_required", reason: "承诺单价缺少原文依据" } },
  }} communicationId="communication:1" subject="Re: PO-001" canOperate />);

  assert.match(html, /部分更新/);
  assert.match(html, /供应商邮件 \+ AI 原文校验/);
  assert.match(html, /本地采购/);
  assert.match(html, /生产\/备货/);
  assert.match(html, /完成度：100%/);
  assert.match(html, /完成数量：200/);
  assert.match(html, /ASN：ASN-001/);
  assert.match(html, /承运商：DHL/);
  assert.match(html, /运单号：DHL-TRACK-001/);
  assert.match(html, /预计到货：2026-09-12/);
  assert.match(html, /承诺单价缺少原文依据/);
  assert.doesNotMatch(html, /来源：人工核验/);
});
