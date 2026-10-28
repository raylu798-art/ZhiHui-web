"use client";

import { ModelConfig, ModelSettingsModal } from '@/components/ModelSettingsModal';
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
} from "@/components/ui/dialog"
import { VisuallyHidden } from "@/components/ui/visually-hidden"
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sparkles, Settings, Loader2, FileText, Check, Square, SlidersHorizontal } from 'lucide-react';
import { TemplateManagerDialog } from './TemplateManagerDialog';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useState, useEffect, useRef, ReactNode } from 'react';
import { isOllamaNotInstalledError } from '@/lib/utils';
import { BuiltInModelInfo } from '@/lib/builtin-ai';
import { useTranslation } from 'react-i18next';

interface SummaryGeneratorButtonGroupProps {
  languageSlot?: ReactNode;
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => void;
  onSaveModelConfig: (config?: ModelConfig) => Promise<void>;
  onGenerateSummary: (customPrompt: string) => Promise<void>;
  onStopGeneration: () => void;
  customPrompt: string;
  summaryStatus: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
  availableTemplates: Array<{ id: string, name: string, description: string }>;
  selectedTemplate: string;
  onTemplateSelect: (templateId: string, templateName: string) => void;
  onTemplatesChanged?: () => void;
  hasTranscripts?: boolean;
  hasSummary?: boolean;
  isModelConfigLoading?: boolean;
  onOpenModelSettings?: (openFn: () => void) => void;
}

export function SummaryGeneratorButtonGroup({
  modelConfig,
  setModelConfig,
  onSaveModelConfig,
  onGenerateSummary,
  onStopGeneration,
  customPrompt,
  summaryStatus,
  availableTemplates,
  selectedTemplate,
  onTemplateSelect,
  onTemplatesChanged,
  hasTranscripts = true,
  hasSummary = false,
  isModelConfigLoading = false,
  onOpenModelSettings,
  languageSlot
}: SummaryGeneratorButtonGroupProps) {
  const { t } = useTranslation();
  const [isCheckingModels, setIsCheckingModels] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [templateManagerOpen, setTemplateManagerOpen] = useState(false);

  // Expose the function to open the modal via callback registration
  useEffect(() => {
    if (onOpenModelSettings) {
      // Register our open dialog function with the parent by calling the callback
      // This allows the parent to store a reference to this function
      const openDialog = () => {
        console.log('📱 Opening model settings dialog via callback');
        setSettingsDialogOpen(true);
      };

      // Call the parent's callback with our open function
      // Note: This assumes onOpenModelSettings accepts a function parameter
      // We'll need to adjust the signature
      onOpenModelSettings(openDialog);
    }
  }, [onOpenModelSettings]);

  if (!hasTranscripts) {
    return null;
  }

  const checkBuiltInAIModelsAndGenerate = async () => {
    setIsCheckingModels(true);
    try {
      const selectedModel = modelConfig.model;

      // Check if specific model is configured
      if (!selectedModel) {
        toast.error(t('summaryGenerator.noBuiltinModel'), {
          description: t('summaryGenerator.noBuiltinModelDesc'),
          duration: 5000,
        });
        setSettingsDialogOpen(true);
        return;
      }

      // Check model readiness (with filesystem refresh)
      const isReady = await invoke<boolean>('builtin_ai_is_model_ready', {
        modelName: selectedModel,
        refresh: true,
      });

      if (isReady) {
        // Model is available, proceed with generation
        onGenerateSummary(customPrompt);
        return;
      }

      // Model not ready - check detailed status
      const modelInfo = await invoke<BuiltInModelInfo | null>('builtin_ai_get_model_info', {
        modelName: selectedModel,
      });

      if (!modelInfo) {
        toast.error(t('summaryGenerator.modelNotFound'), {
          description: t('summaryGenerator.modelNotFoundDesc', { model: selectedModel }),
          duration: 5000,
        });
        setSettingsDialogOpen(true);
        return;
      }

      // Handle different model states
      const status = modelInfo.status;

      if (status.type === 'downloading') {
        toast.info(t('summaryGenerator.downloadInProgress'), {
          description: t('summaryGenerator.downloadInProgressDesc', { model: selectedModel, progress: status.progress }),
          duration: 5000,
        });
        return;
      }

      if (status.type === 'not_downloaded') {
        toast.error(t('summaryGenerator.notDownloaded'), {
          description: t('summaryGenerator.notDownloadedDesc', { model: selectedModel }),
          duration: 5000,
        });
        setSettingsDialogOpen(true);
        return;
      }

      if (status.type === 'corrupted') {
        toast.error(t('summaryGenerator.corrupted'), {
          description: t('summaryGenerator.corruptedDesc', { model: selectedModel }),
          duration: 7000,
        });
        setSettingsDialogOpen(true);
        return;
      }

      if (status.type === 'error') {
        toast.error(t('summaryGenerator.modelError'), {
          description: status.Error || t('summaryGenerator.modelErrorDesc'),
          duration: 5000,
        });
        setSettingsDialogOpen(true);
        return;
      }

      // Fallback
      toast.error(t('summaryGenerator.notAvailable'), {
        description: t('summaryGenerator.notAvailableDesc'),
        duration: 5000,
      });
      setSettingsDialogOpen(true);

    } catch (error) {
      console.error('Error checking built-in AI models:', error);
      toast.error(t('summaryGenerator.checkStatusFailed'), {
        description: error instanceof Error ? error.message : String(error),
        duration: 5000,
      });
    } finally {
      setIsCheckingModels(false);
    }
  };

  const checkOllamaModelsAndGenerate = async () => {
    // Handle built-in AI provider
    if (modelConfig.provider === 'builtin-ai') {
      await checkBuiltInAIModelsAndGenerate();
      return;
    }

    // Only check for Ollama provider
    if (modelConfig.provider !== 'ollama') {
      onGenerateSummary(customPrompt);
      return;
    }

    setIsCheckingModels(true);
    try {
      const endpoint = modelConfig.ollamaEndpoint || null;
      const models = await invoke('get_ollama_models', { endpoint }) as any[];

      if (!models || models.length === 0) {
        // No models available, show message and open settings
        toast.error(
          t('summaryGenerator.noOllamaModels'),
          { duration: 5000 }
        );
        setSettingsDialogOpen(true);
        return;
      }

      // Models are available, proceed with generation
      onGenerateSummary(customPrompt);
    } catch (error) {
      console.error('Error checking Ollama models:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (isOllamaNotInstalledError(errorMessage)) {
        // Ollama is not installed - show specific message with download link
        toast.error(
          t('summaryGenerator.ollamaNotInstalled'),
          {
            description: t('summaryGenerator.ollamaNotInstalledDesc'),
            duration: 7000,
            action: {
              label: t('common.download'),
              onClick: () => invoke('open_external_url', { url: 'https://ollama.com/download' })
            }
          }
        );
      } else {
        // Other error - generic message
        toast.error(
          t('summaryGenerator.checkOllamaFailed'),
          { duration: 5000 }
        );
      }
      setSettingsDialogOpen(true);
    } finally {
      setIsCheckingModels(false);
    }
  };

  const isGenerating = summaryStatus === 'processing' || summaryStatus === 'summarizing' || summaryStatus === 'regenerating';

  return (
    <ButtonGroup>
      {/* Generate Summary or Stop button */}
      {isGenerating ? (
        <Button
          variant="outline"
          size="sm"
          className="bg-gradient-to-r from-red-50 to-orange-50 hover:from-red-100 hover:to-orange-100 border-red-200 xl:px-4"
          onClick={() => {
            Analytics.trackButtonClick('stop_summary_generation', 'meeting_details');
            onStopGeneration();
          }}
          title={t('summaryGenerator.stopTitle')}
        >
          <Square className="xl:mr-2" size={18} fill="currentColor" />
          <span className="hidden lg:inline xl:inline">{t('summaryGenerator.stop')}</span>
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="bg-gradient-to-r from-blue-50 to-purple-50 hover:from-blue-100 hover:to-purple-100 border-blue-200 xl:px-4"
          onClick={() => {
            Analytics.trackButtonClick('generate_summary', 'meeting_details');
            checkOllamaModelsAndGenerate();
          }}
          disabled={isCheckingModels || isModelConfigLoading}
          title={
            isModelConfigLoading
              ? t('summaryGenerator.loadingConfig')
              : isCheckingModels
                ? t('summaryGenerator.checkingModels')
                : hasSummary ? t('summaryGenerator.regenerateTitle') : t('summaryGenerator.generateTitle')
          }
        >
          {isCheckingModels || isModelConfigLoading ? (
            <>
              <Loader2 className="animate-spin xl:mr-2" size={18} />
              <span className="hidden xl:inline">{t('summaryGenerator.processing')}</span>
            </>
          ) : (
            <>
              <Sparkles className="xl:mr-2" size={18} />
              <span className="hidden lg:inline xl:inline">{hasSummary ? t('summaryGenerator.regenerate') : t('summaryGenerator.generate')}</span>
            </>
          )}
        </Button>
      )}

      {languageSlot}

      {/* Settings button */}
      <Dialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            title={t('summaryGenerator.settingsTitle')}
          >
            <Settings />
            <span className="hidden lg:inline">{t('summaryGenerator.aiModel')}</span>
          </Button>
        </DialogTrigger>
        <DialogContent
          aria-describedby={undefined}
          className="max-w-4xl w-full overflow-hidden"
        >
          <VisuallyHidden>
            <DialogTitle>{t('summaryGenerator.modelSettings')}</DialogTitle>
          </VisuallyHidden>
          <ModelSettingsModal
            onSave={async (config) => {
              await onSaveModelConfig(config);
              setSettingsDialogOpen(false);
            }}
            modelConfig={modelConfig}
            setModelConfig={setModelConfig}
            skipInitialFetch={true}
            layout="dialog"
          />
        </DialogContent>
      </Dialog>

      {/* Template selector dropdown */}
      {availableTemplates.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              title={t('summaryGenerator.selectTemplate')}
            >
              <FileText />
              <span className="hidden lg:inline">{t('summaryGenerator.template')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {availableTemplates.map((template) => (
              <DropdownMenuItem
                key={template.id}
                onClick={() => onTemplateSelect(template.id, template.name)}
                title={template.description}
                className="flex items-center justify-between gap-2"
              >
                <span>{template.name}</span>
                {selectedTemplate === template.id && (
                  <Check className="h-4 w-4 text-green-600" />
                )}
              </DropdownMenuItem>
            ))}

            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => setTemplateManagerOpen(true)}
              className="flex items-center gap-2"
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span>{t('templateManager.menuEntry')}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <TemplateManagerDialog
        open={templateManagerOpen}
        onOpenChange={setTemplateManagerOpen}
        templates={availableTemplates}
        onTemplatesChanged={() => onTemplatesChanged?.()}
      />
    </ButtonGroup>
  );
}
