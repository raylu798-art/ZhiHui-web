'use client';

import { useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/lib/i18n/config';

/**
 * Mounts i18next for the whole app. Kept as a thin client component so it can
 * live at the root of the (client) layout without turning extra files into
 * client modules. Also mirrors the active language onto <html lang> for
 * accessibility and correct font/hyphenation behavior.
 */
export function I18nProvider({ children }: { children: React.ReactNode }) {
  // Two-pass render: SSR/first client render emit nothing, then mount flips to
  // the translated tree. i18n resources are bundled synchronously, so on the
  // server isInitialized is already true — but the server has no localStorage/
  // navigator and renders fallback English, while the client detects zh-CN.
  // Gating on mount keeps both first renders identical and avoids the Next.js
  // hydration mismatch (desktop app: no SEO cost, only a blank first frame).
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (i18n.isInitialized) {
      setMounted(true);
    } else {
      const onInit = () => setMounted(true);
      i18n.on('initialized', onInit);
      return () => {
        i18n.off('initialized', onInit);
      };
    }
  }, []);

  useEffect(() => {
    const applyLang = (lng: string) => {
      if (typeof document !== 'undefined') {
        document.documentElement.lang = lng;
      }
    };
    applyLang(i18n.language);
    i18n.on('languageChanged', applyLang);
    return () => {
      i18n.off('languageChanged', applyLang);
    };
  }, []);

  // Avoid a flash of untranslated content before init resolves.
  if (!mounted) return null;

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

export default I18nProvider;
