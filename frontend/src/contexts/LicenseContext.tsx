'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface LicenseStatusData {
  status: 'trial' | 'active' | 'expired';
  days_remaining?: number;
  trial_days_total?: number;
  expires_at?: string;
  license_key_masked?: string;
  reason?: string;
  device_name: string;
  fingerprint_short: string;
  server_url: string;
}

export interface VerifyResult {
  server_status: string;
  message: string;
  status: LicenseStatusData['status'];
}

interface LicenseContextValue {
  license: LicenseStatusData | null;
  loading: boolean;
  isFeatureAllowed: () => boolean;
  activate: (key: string) => Promise<LicenseStatusData>;
  deactivate: () => Promise<LicenseStatusData>;
  verifyNow: () => Promise<VerifyResult>;
  setServerUrl: (url: string) => Promise<string>;
  refresh: () => Promise<void>;
}

const LicenseContext = createContext<LicenseContextValue | null>(null);

export function LicenseProvider({ children }: { children: React.ReactNode }) {
  const [license, setLicense] = useState<LicenseStatusData | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const status = await invoke<LicenseStatusData>('license_get_status');
      setLicense(status);
    } catch (e) {
      console.error('Failed to get license status:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();

    let unlisten: UnlistenFn | undefined;
    let disposed = false;

    listen<LicenseStatusData>('license-status-changed', (event) => {
      // Backend emits the bare status enum; merge with device info from last full payload
      setLicense((prev) => {
        const next = event.payload;
        if (!prev) return next;
        return {
          ...next,
          device_name: (next as any).device_name ?? prev.device_name,
          fingerprint_short: (next as any).fingerprint_short ?? prev.fingerprint_short,
          server_url: (next as any).server_url ?? prev.server_url,
        };
      });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const isFeatureAllowed = useCallback(() => {
    if (!license) return true; // still loading - don't block UI prematurely
    return license.status === 'trial' || license.status === 'active';
  }, [license]);

  const activate = useCallback(async (key: string) => {
    const result = await invoke<LicenseStatusData>('license_activate', { key });
    setLicense(result);
    return result;
  }, []);

  const deactivate = useCallback(async () => {
    const result = await invoke<LicenseStatusData>('license_deactivate');
    setLicense(result);
    return result;
  }, []);

  const verifyNow = useCallback(async () => {
    const result = await invoke<VerifyResult>('license_verify_now');
    await refresh();
    return result;
  }, [refresh]);

  const setServerUrl = useCallback(
    async (url: string) => {
      const saved = await invoke<string>('license_set_server_url', { url });
      await refresh();
      return saved;
    },
    [refresh]
  );

  return (
    <LicenseContext.Provider
      value={{
        license,
        loading,
        isFeatureAllowed,
        activate,
        deactivate,
        verifyNow,
        setServerUrl,
        refresh,
      }}
    >
      {children}
    </LicenseContext.Provider>
  );
}

export function useLicense(): LicenseContextValue {
  const ctx = useContext(LicenseContext);
  if (!ctx) {
    throw new Error('useLicense must be used within LicenseProvider');
  }
  return ctx;
}
