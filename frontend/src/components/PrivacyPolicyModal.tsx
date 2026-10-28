'use client';

import React from 'react';
import { X, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface PolicySection {
  title: string;
  items: string[];
}

interface PrivacyPolicyModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * In-app privacy policy viewer. Shows the ZhiHui privacy policy inside the
 * app (no external navigation), rendered from the active locale resources.
 */
export default function PrivacyPolicyModal({ isOpen, onClose }: PrivacyPolicyModalProps) {
  const { t } = useTranslation();
  if (!isOpen) return null;

  const sections = t('privacyPolicy.sections', { returnObjects: true }) as PolicySection[];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-6 h-6 text-blue-600" />
            <div>
              <h2 className="text-xl font-semibold text-gray-900">{t('privacyPolicy.title')}</h2>
              <p className="text-xs text-gray-500 mt-0.5">{t('privacyPolicy.updated')}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label={t('common.close')}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto">
          <p className="text-sm text-gray-700 leading-relaxed">{t('privacyPolicy.intro')}</p>

          {Array.isArray(sections) &&
            sections.map((section, i) => (
              <div key={i} className="border border-gray-200 rounded-lg p-4">
                <h3 className="font-semibold text-gray-900 mb-2">{section.title}</h3>
                <ul className="text-sm text-gray-700 space-y-1 ml-4 list-disc marker:text-gray-400">
                  {section.items.map((item, j) => (
                    <li key={j} className="leading-relaxed">{item}</li>
                  ))}
                </ul>
              </div>
            ))}
        </div>

        {/* Footer */}
        <div className="flex justify-end p-4 border-t border-gray-200">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-gray-900 text-white text-sm rounded-md hover:bg-gray-800 transition-colors font-medium"
          >
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
