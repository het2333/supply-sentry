/**
 * Lightweight document gate used before handing an attachment to a parser or
 * an external connector.  This is deliberately a content/type consistency
 * check; it is not an anti-virus or malware scanner.
 */

export type DocumentSecurityStatus = "pending_scan" | "clean" | "quarantined";

export interface ProcurementDocumentSecurityInput {
  fileName: string;
  declaredMimeType?: string | null;
  bytes: Uint8Array;
}

export interface ProcurementDocumentSecurityResult {
  detectedContentType: string;
  securityStatus: DocumentSecurityStatus;
  reason: string;
  safeForProcessing: boolean;
  safeForExternalSend: boolean;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
  dwg: "image/vnd.dwg", dxf: "application/dxf", step: "model/step", stp: "model/step",
};

function ext(name: string): string {
  const value = name.trim().toLowerCase().split(/[?#]/u)[0] ?? "";
  return value.includes(".") ? (value.split(".").pop() ?? "") : "";
}

function starts(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start = 0, length = bytes.length): string {
  return new TextDecoder('latin1').decode(bytes.slice(start, Math.min(bytes.length, start + length)));
}

function hasZipEntry(bytes: Uint8Array, names: RegExp): boolean {
  // Central-directory filenames are plain ASCII/UTF-8 and are sufficient for
  // identifying OOXML containers without introducing a ZIP implementation.
  const text = ascii(bytes);
  return names.test(text);
}

function quarantine(detectedContentType: string, reason: string): ProcurementDocumentSecurityResult {
  return { detectedContentType, securityStatus: "quarantined", reason, safeForProcessing: false, safeForExternalSend: false };
}

/** Perform basic magic-byte, extension, MIME and text-content validation. */
export function assessProcurementDocumentSecurity(input: ProcurementDocumentSecurityInput): ProcurementDocumentSecurityResult {
  const bytes = input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes);
  const extension = ext(input.fileName);
  const declared = (input.declaredMimeType ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "";

  if (!input.fileName.trim() || bytes.length === 0) return quarantine("application/octet-stream", "文件名或文件内容为空");
  if (starts(bytes, [0x4d, 0x5a]) || starts(bytes, [0x7f, 0x45, 0x4c, 0x46]) || ascii(bytes, 0, 2) === "#!") {
    return quarantine("application/x-executable", "检测到可执行文件或脚本头，禁止作为采购文档处理");
  }

  let detected: string;
  let isZip = false;
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) detected = MIME.pdf!;
  else if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) detected = MIME.png!;
  else if (starts(bytes, [0xff, 0xd8, 0xff])) detected = MIME.jpeg!;
  else if (ascii(bytes, 0, 4) === "GIF8") detected = MIME.gif!;
  else if (extension === "dwg" && /^AC10\d{2}/u.test(ascii(bytes, 0, 6))) detected = MIME.dwg!;
  else if (extension === "dxf" && /SECTION[\s\S]{0,80}HEADER/u.test(ascii(bytes, 0, Math.min(bytes.length, 512)))) detected = MIME.dxf!;
  else if (["step", "stp"].includes(extension) && /ISO-10303-21;/u.test(ascii(bytes, 0, Math.min(bytes.length, 512)))) detected = MIME[extension]!;
  else if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06]) || starts(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    isZip = true;
    if (extension === "docx" && hasZipEntry(bytes, /word\/document\.xml|word\//u)) detected = MIME.docx!;
    else if (extension === "xlsx" && hasZipEntry(bytes, /xl\/workbook\.xml|xl\//u)) detected = MIME.xlsx!;
    else detected = MIME.zip!;
  } else if (["txt", "md", "csv", "json"].includes(extension)) {
    if (bytes.includes(0)) return quarantine("text/plain", "文本包含 NUL 字节，可能是伪装的二进制文件");
    for (const byte of bytes) if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) return quarantine("text/plain", "文本包含不可接受的控制字符");
    detected = MIME[extension] ?? "text/plain";
  } else {
    return quarantine("application/octet-stream", "无法识别文件内容，需进入隔离区进行深度检查");
  }

  const expected = MIME[extension];
  if (expected && expected !== detected && !(isZip && extension === "zip" && detected === MIME.zip)) return quarantine(detected, `文件扩展名与内容不一致（.${extension}）`);
  if (declared && declared !== detected && declared !== "application/octet-stream") return quarantine(detected, "声明的 MIME 类型与文件内容不一致");
  return {
    detectedContentType: detected,
    securityStatus: "pending_scan",
    reason: "基础文件内容与声明一致；尚未执行恶意软件扫描",
    safeForProcessing: true,
    safeForExternalSend: false,
  };
}

export const validateProcurementDocumentSecurity = assessProcurementDocumentSecurity;
