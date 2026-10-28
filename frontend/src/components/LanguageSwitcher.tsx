'use client';

import { Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  SUPPORTED_LANGUAGES,
  APP_LANGUAGE_STORAGE_KEY,
  normalizeLanguage,
} from '@/lib/i18n/config';

/**
 * Interface language picker. Offers the explicitly supported UI languages;
 * defaults to Simplified Chinese when the user has not made a choice.
 */
export function LanguageSwitcher() {
  const { t, i18n } = useTranslation();

  // Explicit user override if stored; otherwise default to Simplified Chinese.
  const stored =
    typeof window !== 'undefined'
      ? localStorage.getItem(APP_LANGUAGE_STORAGE_KEY)
      : null;
  const currentValue = stored ? normalizeLanguage(stored) : 'zh-CN';

  const handleChange = (value: string) => {
    i18n.changeLanguage(value); // languagedetector caches to localStorage
  };

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <Globe size={18} className="text-gray-500" />
        <h3 className="text-lg font-semibold text-gray-900">
          {t('settings.appLanguage.title')}
        </h3>
      </div>
      <p className="text-sm text-gray-600 mb-4">
        {t('settings.appLanguage.description')}
      </p>

      <select
        value={currentValue}
        onChange={(e) => handleChange(e.target.value)}
        className="w-full max-w-xs rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default LanguageSwitcher;
