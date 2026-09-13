"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { apiRequest, configurePublicDemoApiRuntime } from "@/features/shared/api-client";

export interface PublicDemoCapabilities {
  syntheticData: true;
  externalDelivery: false;
  uploads: false;
  credentialManagement: false;
}

export interface PublicDemoStatus {
  demoMode: true;
  tenantId: "t:public-demo";
  seedVersion: string;
  generation: number;
  resetAt: string;
  status: "healthy" | "degraded";
}

export interface PublicDemoState {
  demoMode: boolean;
  generation: number | null;
  status: PublicDemoStatus["status"] | "loading" | "unavailable";
  resetNotice: boolean;
  capabilities: PublicDemoCapabilities | null;
  setDemoMode: (enabled: boolean) => void;
  refreshStatus: () => Promise<void>;
}

const PublicDemoContext = createContext<PublicDemoState>({
  demoMode: false,
  generation: null,
  status: "unavailable",
  resetNotice: false,
  capabilities: null,
  setDemoMode: () => undefined,
  refreshStatus: async () => undefined,
});

export function PublicDemoProvider({ children }: { children: ReactNode }) {
  const [demoMode, updateDemoMode] = useState(false);
  const [generation, setGeneration] = useState<number | null>(null);
  const [status, setStatus] = useState<PublicDemoState["status"]>("unavailable");
  const [resetNotice, setResetNotice] = useState(false);

  const setDemoMode = useCallback((enabled: boolean) => {
    updateDemoMode(enabled);
    if (!enabled) {
      setGeneration(null);
      setStatus("unavailable");
      setResetNotice(false);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    setStatus("loading");
    try {
      const next = await apiRequest<PublicDemoStatus>("/api/public-demo/status");
      updateDemoMode(next.demoMode === true);
      setGeneration(next.generation);
      setStatus(next.status);
    } catch {
      setGeneration(null);
      setStatus("unavailable");
    }
  }, []);

  useEffect(() => configurePublicDemoApiRuntime({
    getGeneration: () => generation,
    onGeneration: (next) => setGeneration(next),
    onGenerationConflict: async () => {
      await refreshStatus();
      setResetNotice(true);
    },
  }), [generation, refreshStatus]);

  const value = useMemo<PublicDemoState>(() => ({
    demoMode,
    generation,
    status,
    resetNotice,
    capabilities: demoMode ? {
      syntheticData: true,
      externalDelivery: false,
      uploads: false,
      credentialManagement: false,
    } : null,
    setDemoMode,
    refreshStatus,
  }), [demoMode, generation, refreshStatus, resetNotice, setDemoMode, status]);

  return <PublicDemoContext.Provider value={value}>{children}</PublicDemoContext.Provider>;
}

export function usePublicDemo(): PublicDemoState {
  return useContext(PublicDemoContext);
}
