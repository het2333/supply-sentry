export type UiLanguage = "zh-CN" | "en";
export const UI_LANGUAGE_STORAGE_KEY = "supply-sentry.ui-language";

export function parseUiLanguage(value: string | null | undefined): UiLanguage | null {
  if (value === "en" || value === "en-US" || value === "en-GB") return "en";
  if (value === "zh" || value === "zh-CN") return "zh-CN";
  return null;
}

export function resolveUiLanguage(search: string, stored: string | null): UiLanguage {
  return parseUiLanguage(new URLSearchParams(search).get("lang")) ?? parseUiLanguage(stored) ?? "zh-CN";
}
