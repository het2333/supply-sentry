"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiRequest, notifyAuthenticationRequired, ReadyworkApiError } from "@/features/shared/api-client";

export type ProcurementRealtimeFamily = "pos" | "outbox" | "messages" | "notifications";
export type ProcurementRealtimeStatus = "connecting" | "live" | "retrying";

export type ProcurementRealtimeEventDetail = {
  id: string;
  family: ProcurementRealtimeFamily | "reset";
  eventType: string;
  objectId: string | null;
  objectVersion: string | null;
  occurredAt: string;
};

export const READYWORK_PROCUREMENT_REALTIME_EVENT = "readywork:procurement-realtime";

const RealtimeStatusContext = createContext<{
  status: ProcurementRealtimeStatus;
  lastEventAt: string | null;
} | null>(null);

function parseEvent(event: MessageEvent<string>, family: ProcurementRealtimeFamily): ProcurementRealtimeEventDetail | null {
  try {
    const payload = JSON.parse(event.data) as Record<string, unknown>;
    return {
      id: String(payload["id"] ?? event.lastEventId ?? ""),
      family,
      eventType: String(payload["eventType"] ?? `${family}.changed`),
      objectId: payload["objectId"] === null || payload["objectId"] === undefined ? null : String(payload["objectId"]),
      objectVersion: payload["objectVersion"] === null || payload["objectVersion"] === undefined ? null : String(payload["objectVersion"]),
      occurredAt: String(payload["occurredAt"] ?? new Date().toISOString()),
    };
  } catch {
    return null;
  }
}

function dispatch(detail: ProcurementRealtimeEventDetail): void {
  window.dispatchEvent(new CustomEvent<ProcurementRealtimeEventDetail>(READYWORK_PROCUREMENT_REALTIME_EVENT, { detail }));
}

export function ProcurementRealtimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ProcurementRealtimeStatus>("connecting");
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const authCheckActive = useRef(false);

  useEffect(() => {
    const source = new EventSource("/api/events?stream=1");
    const families: ProcurementRealtimeFamily[] = ["pos", "outbox", "messages", "notifications"];
    const listeners = new Map<ProcurementRealtimeFamily, (event: Event) => void>();

    const ready = () => setStatus("live");
    source.addEventListener("ready", ready);
    for (const family of families) {
      const listener = (raw: Event) => {
        const detail = parseEvent(raw as MessageEvent<string>, family);
        if (!detail) return;
        setStatus("live");
        setLastEventAt(detail.occurredAt);
        dispatch(detail);
      };
      listeners.set(family, listener);
      source.addEventListener(family, listener);
    }
    const reset = (raw: Event) => {
      let id = (raw as MessageEvent<string>).lastEventId ?? "";
      try { id = String((JSON.parse((raw as MessageEvent<string>).data) as Record<string, unknown>)["cursor"] ?? id); } catch { /* reset still invalidates all views */ }
      const occurredAt = new Date().toISOString();
      setStatus("live");
      setLastEventAt(occurredAt);
      dispatch({ id, family: "reset", eventType: "stream.reset", objectId: null, objectVersion: null, occurredAt });
    };
    source.addEventListener("reset", reset);
    source.onopen = () => setStatus("live");
    source.onerror = () => {
      setStatus("retrying");
      if (authCheckActive.current) return;
      authCheckActive.current = true;
      window.setTimeout(() => {
        void apiRequest("/api/auth/me")
          .catch((error) => { if (error instanceof ReadyworkApiError && error.status === 401) notifyAuthenticationRequired(); })
          .finally(() => { authCheckActive.current = false; });
      }, 1_000);
    };
    return () => {
      source.removeEventListener("ready", ready);
      source.removeEventListener("reset", reset);
      for (const [family, listener] of listeners) source.removeEventListener(family, listener);
      source.close();
    };
  }, []);

  const value = useMemo(() => ({ status, lastEventAt }), [lastEventAt, status]);
  return <RealtimeStatusContext.Provider value={value}>{children}</RealtimeStatusContext.Provider>;
}

export function useProcurementRealtimeStatus() {
  return useContext(RealtimeStatusContext) ?? { status: "connecting" as const, lastEventAt: null };
}

export function useProcurementRealtimeRefresh(
  families: readonly ProcurementRealtimeFamily[],
  refresh: () => void,
  debounceMs = 250,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const familyKey = [...families].sort().join(",");

  useEffect(() => {
    const selected = new Set(familyKey.split(",").filter(Boolean));
    let timer: number | null = null;
    const listener = (raw: Event) => {
      const detail = (raw as CustomEvent<ProcurementRealtimeEventDetail>).detail;
      if (!detail || (detail.family !== "reset" && !selected.has(detail.family))) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        refreshRef.current();
      }, debounceMs);
    };
    window.addEventListener(READYWORK_PROCUREMENT_REALTIME_EVENT, listener);
    return () => {
      window.removeEventListener(READYWORK_PROCUREMENT_REALTIME_EVENT, listener);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [debounceMs, familyKey]);
}
