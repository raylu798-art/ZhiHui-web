'use client';

import { useEffect, useState } from 'react';
import type { VersionInfo } from './api';

/** Public deployment metadata only. No credentials or user settings are requested. */
export function SiteFooter() {
  const [registration, setRegistration] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/version', { cache: 'no-store', credentials: 'omit', signal: controller.signal })
      .then(async response => response.ok ? response.json() as Promise<VersionInfo> : null)
      .then(value => {
        const number = value?.icp_registration;
        if (!controller.signal.aborted && typeof number === 'string' && [...number].length <= 100 && !/[\u0000-\u001f\u007f-\u009f]/u.test(number)) {
          setRegistration(number.trim() || null);
        }
      })
      .catch(() => { /* Optional site metadata must not interrupt meeting work. */ });
    return () => controller.abort();
  }, []);

  return registration ? <footer className="site-footer"><a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">{registration}</a></footer> : null;
}
