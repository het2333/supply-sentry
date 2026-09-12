"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiRequest } from "@/features/shared/api-client";
import {
  DEFAULT_PROCUREMENT_TENANT_PREFERENCES,
  formatProcurementDate,
  type ProcurementTenantPreferences,
} from "@/features/procurement/tenant-locale";

export {
  DEFAULT_PROCUREMENT_TENANT_PREFERENCES,
  formatProcurementDate,
  procurementCalendarDate,
  procurementCalendarDateDaysBefore,
  type ProcurementDateFormat,
  type ProcurementTenantPreferences,
} from "@/features/procurement/tenant-locale";

export type StoredProcurementTenantPreferences = ProcurementTenantPreferences & {
  version: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ProcurementTenantPreferencesResponse = {
  item: StoredProcurementTenantPreferences | null;
  effective: ProcurementTenantPreferences;
  inheritedDefault: boolean;
  permissions: { read: boolean; configure: boolean };
  events: Array<{ id: string; actorId: string; action: string; detail: Record<string, unknown>; createdAt: string }>;
};

type ProcurementTenantPreferencesContextValue = {
  response: ProcurementTenantPreferencesResponse | null;
  preferences: ProcurementTenantPreferences;
  loading: boolean;
  error: unknown;
  refresh: () => Promise<void>;
  acceptResponse: (response: ProcurementTenantPreferencesResponse) => void;
};

const ProcurementTenantPreferencesContext = createContext<ProcurementTenantPreferencesContextValue | null>(null);

export function ProcurementTenantPreferencesProvider({ children }: { children: ReactNode }) {
  const [response, setResponse] = useState<ProcurementTenantPreferencesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    try {
      const next = await apiRequest<ProcurementTenantPreferencesResponse>("/api/procurement/tenant-preferences");
      if (generation === requestGeneration.current) setResponse(next);
    } catch (requestError) {
      if (generation === requestGeneration.current) setError(requestError);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const generationRef = requestGeneration;
    void refresh();
    return () => { generationRef.current++; };
  }, [refresh]);

  const acceptResponse = useCallback((next: ProcurementTenantPreferencesResponse) => {
    requestGeneration.current++;
    setResponse(next);
    setError(null);
    setLoading(false);
  }, []);

  const value = useMemo<ProcurementTenantPreferencesContextValue>(() => ({
    response,
    preferences: response?.effective ?? DEFAULT_PROCUREMENT_TENANT_PREFERENCES,
    loading,
    error,
    refresh,
    acceptResponse,
  }), [acceptResponse, error, loading, refresh, response]);

  return <ProcurementTenantPreferencesContext.Provider value={value}>{children}</ProcurementTenantPreferencesContext.Provider>;
}

export function useProcurementTenantPreferences(): ProcurementTenantPreferencesContextValue {
  const value = useContext(ProcurementTenantPreferencesContext);
  if (!value) throw new Error("useProcurementTenantPreferences 必须在 ProcurementTenantPreferencesProvider 内使用");
  return value;
}

export function useProcurementLocale() {
  const { preferences } = useProcurementTenantPreferences();
  return useMemo(() => ({
    preferences,
    formatDate: (value: string | number | Date | null | undefined, fallback = "—") => formatProcurementDate(value, preferences, "date", fallback),
    formatDateTime: (value: string | number | Date | null | undefined, fallback = "—") => formatProcurementDate(value, preferences, "date-time", fallback),
    formatShortDateTime: (value: string | number | Date | null | undefined, fallback = "—") => formatProcurementDate(value, preferences, "short-date-time", fallback),
    formatTime: (value: string | number | Date | null | undefined, fallback = "—") => formatProcurementDate(value, preferences, "time", fallback),
  }), [preferences]);
}
