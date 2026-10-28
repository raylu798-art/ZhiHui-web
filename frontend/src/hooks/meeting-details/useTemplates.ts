import { useState, useEffect, useCallback } from 'react';
import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import i18n from '@/lib/i18n/config';
import Analytics from '@/lib/analytics';

const SELECTED_TEMPLATE_KEY = 'selectedSummaryTemplate';

export function useTemplates() {
  const [availableTemplates, setAvailableTemplates] = useState<Array<{
    id: string;
    name: string;
    description: string;
  }>>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('standard_meeting');

  // Restore the last selected template (validated against the list on refresh)
  useEffect(() => {
    const stored = localStorage.getItem(SELECTED_TEMPLATE_KEY);
    if (stored) setSelectedTemplate(stored);
  }, []);

  // Fetch available templates on mount (and after template management edits)
  const refreshTemplates = useCallback(async () => {
    try {
      const templates = await invokeTauri('api_list_templates') as Array<{
        id: string;
        name: string;
        description: string;
      }>;
      console.log('Available templates:', templates);
      setAvailableTemplates(templates);
      // If the selected template was deleted, fall back to the default
      setSelectedTemplate((prev) => {
        if (templates.some((tpl) => tpl.id === prev)) return prev;
        localStorage.removeItem(SELECTED_TEMPLATE_KEY);
        return 'standard_meeting';
      });
    } catch (error) {
      console.error('Failed to fetch templates:', error);
    }
  }, []);

  useEffect(() => {
    refreshTemplates();
  }, [refreshTemplates]);

  // Handle template selection
  const handleTemplateSelection = useCallback((templateId: string, templateName: string) => {
    setSelectedTemplate(templateId);
    localStorage.setItem(SELECTED_TEMPLATE_KEY, templateId);
    toast.success(i18n.t('toasts.templateSelected'), {
      description: i18n.t('toasts.templateSelectedDesc', { name: templateName }),
    });
    Analytics.trackFeatureUsed('template_selected');
  }, []);

  // Auto-default: plain-text documents (no audio timestamps) get the general
  // document template, but only while the user has never explicitly chosen one.
  const applyDocumentDefault = useCallback((isTextDocument: boolean) => {
    if (!isTextDocument) return;
    if (localStorage.getItem(SELECTED_TEMPLATE_KEY)) return; // explicit choice wins
    setSelectedTemplate((prev) => (prev === 'standard_meeting' ? 'general_document' : prev));
  }, []);

  return {
    availableTemplates,
    selectedTemplate,
    handleTemplateSelection,
    applyDocumentDefault,
    refreshTemplates,
  };
}
