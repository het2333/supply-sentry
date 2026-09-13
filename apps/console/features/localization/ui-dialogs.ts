import { translateReadyworkUiText } from "./chinese-ui-localization";

export function currentUiText(message: string): string {
  return translateReadyworkUiText(message, typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "zh-CN");
}

export function uiConfirm(message: string): boolean { return window.confirm(currentUiText(message)); }
export function uiAlert(message: string): void { window.alert(currentUiText(message)); }
// The retained/default response is business evidence, not interface copy.
export function uiPrompt(message: string, defaultValue = ""): string | null { return window.prompt(currentUiText(message), defaultValue); }
