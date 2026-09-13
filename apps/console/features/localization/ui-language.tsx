"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChineseUiLocalization } from "./chinese-ui-localization";
import { parseUiLanguage, resolveUiLanguage, UI_LANGUAGE_STORAGE_KEY, type UiLanguage } from "./ui-language-preference";

const UiLanguageContext = createContext<{ language: UiLanguage; setLanguage: (language: UiLanguage) => void }>({ language: "zh-CN", setLanguage: () => {} });

export function UiLanguageProvider({ children }: { children: ReactNode }) {
  // Hydrate the server's source markup, then apply the preference without
  // unmounting business components, clearing drafts or refetching business data.
  const [language, updateLanguage] = useState<UiLanguage>("zh-CN");
  const setLanguage = useCallback((next: UiLanguage) => {
    updateLanguage(next);
    try { window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, next); } catch { /* Storage may be disabled; the current tab still works. */ }
    const url = new URL(window.location.href);
    url.searchParams.set("lang", next);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  useEffect(() => {
    function restorePreference() {
      let stored: string | null = null;
      try { stored = window.localStorage.getItem(UI_LANGUAGE_STORAGE_KEY); } catch { /* Embedded browsers may disable storage. */ }
      const next = resolveUiLanguage(window.location.search, stored);
      updateLanguage(next);
      try { window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, next); } catch { /* UI preference only. */ }
    }
    function syncTab(event: StorageEvent) {
      const next = parseUiLanguage(event.newValue);
      if (event.key === UI_LANGUAGE_STORAGE_KEY && next) setLanguage(next);
    }
    restorePreference();
    window.addEventListener("popstate", restorePreference);
    window.addEventListener("storage", syncTab);
    return () => { window.removeEventListener("popstate", restorePreference); window.removeEventListener("storage", syncTab); };
  }, [setLanguage]);

  const value = useMemo(() => ({ language, setLanguage }), [language, setLanguage]);
  return <UiLanguageContext.Provider value={value}><ChineseUiLocalization language={language} />{children}</UiLanguageContext.Provider>;
}

export function useUiLanguage() { return useContext(UiLanguageContext); }

export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { language, setLanguage } = useUiLanguage();
  return <div data-preserve-language role="group" aria-label="Interface language / 界面语言" className={`inline-flex shrink-0 items-center rounded-xl border border-slate-200 bg-white p-1 text-xs shadow-sm ${className}`}>
    {([['zh-CN', '中文'], ['en', 'English']] as const).map(([value, label]) => <button key={value} type="button" lang={value} aria-pressed={language === value} onClick={() => setLanguage(value)} className={`rounded-lg px-2.5 py-1.5 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-600 ${language === value ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-slate-50"}`}>{label}</button>)}
  </div>;
}
