"use client";

import { apiRequest } from "@/features/shared/api-client";

type PoDocumentPurpose = "download" | "print";

type PoDocumentSnapshotResponse = {
  pdfUrl: string;
  printUrl: string;
};

/**
 * Creates the immutable, server-projected document and navigates a fresh tab
 * only after that API call succeeds. The printable page is server-owned; this
 * helper intentionally never serializes Console DOM.
 */
export async function openPoDocumentSnapshot({
  purchaseOrderId,
  expectedVersion,
  purpose,
}: {
  purchaseOrderId: string;
  expectedVersion: number;
  purpose: PoDocumentPurpose;
}): Promise<void> {
  const openerFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const windowTarget = window.open("about:blank", "_blank");
  if (!windowTarget) throw new Error("浏览器阻止了文档窗口；请允许此站点打开新窗口后重试。");
  windowTarget.opener = null;
  // Browsers commonly focus a newly reserved tab. Bring keyboard focus back
  // to the initiating menu item while the server generates the snapshot.
  try { windowTarget.blur(); } catch { /* advisory; browser policy may deny it */ }
  try { window.focus(); } catch { /* advisory; browser policy may deny it */ }
  try { openerFocus?.focus({ preventScroll: true }); } catch { /* detached opener */ }
  try {
    const result = await apiRequest<PoDocumentSnapshotResponse>(
      `/api/procurement/purchase-orders/${encodeURIComponent(purchaseOrderId)}/document-snapshots`,
      {
        method: "POST",
        headers: { "Idempotency-Key": `web-po-document:${purchaseOrderId}:${expectedVersion}:${purpose}:${crypto.randomUUID()}` },
        body: { expectedVersion, purpose: purpose === "download" ? "download" : "print" },
      },
    );
    const url = purpose === "download" ? result.pdfUrl : result.printUrl;
    if (!url || !url.startsWith("/api/procurement/")) throw new Error("服务器未返回授权文档地址");
    windowTarget.location.href = url;
  } catch (error) {
    windowTarget?.close();
    throw error;
  }
}
