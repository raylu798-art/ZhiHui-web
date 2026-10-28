'use client';

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

export const SUPPORTED_LANGUAGES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en', label: 'English' },
] as const;

export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number]['code'];

export const APP_LANGUAGE_STORAGE_KEY = 'appLanguage';

/**
 * Normalize any BCP-47 / navigator language tag to one of our supported UI
 * languages. Anything Chinese (zh, zh-CN, zh-Hans, zh-TW, zh-HK...) maps to
 * Simplified Chinese; everything else falls back to English.
 */
export function normalizeLanguage(raw?: string | null): AppLanguage {
  if (!raw) return 'en';
  const lower = raw.toLowerCase();
  if (lower.startsWith('zh')) return 'zh-CN';
  if (lower.startsWith('en')) return 'en';
  return 'en';
}

// Initialize once (guards against Next.js fast-refresh / double-mount).
if (!i18n.isInitialized) {
  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: {
        en: { translation: en },
        'zh-CN': { translation: zhCN },
      },
      fallbackLng: 'zh-CN',
      supportedLngs: ['en', 'zh-CN'],
      // zh variants are normalized to zh-CN via convertDetectedLanguage below,
      // so exact-match loading is safe here. Do NOT set nonExplicitSupportedLngs:
      // it would strip zh-CN to zh, which is absent from supportedLngs and
      // silently falls back to en.
      load: 'currentOnly',
      interpolation: {
        escapeValue: false,
      },
      detection: {
        // Priority: explicit user choice (localStorage) only; the app defaults
        // to Simplified Chinese (fallbackLng) instead of following the system.
        order: ['localStorage'],
        lookupLocalStorage: APP_LANGUAGE_STORAGE_KEY,
        caches: ['localStorage'],
        convertDetectedLanguage: (lng) => normalizeLanguage(lng),
      },
    });
}

export default i18n;
