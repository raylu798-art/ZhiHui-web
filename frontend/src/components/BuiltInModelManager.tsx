'use client';

import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { Download, RefreshCw, BadgeAlert, Trash2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n/config';
import { formatSummaryModelSizeLabelFromMb } from '@/lib/onboarding-summary-model';
import { AddCustomModelDialog } from '@/components/AddCustomModelDialog';

// Sanitize backend model names (e.g. "qwen3.5:2b") into i18n-safe keys
const modelNameKey = (name: string) => name.replace(/[^a-zA-Z0-9]/g, '_');

interface ModelInfo {
  name: string;
  display_name: string;
  status: {
    type: 'not_downloaded' | 'downloading' | 'available' | 'corrupted' | 'error';
    progress?: number;
    message?: string; // Error message when type === 'error'
  };
  size_mb: number;
  context_size: number;
  description: string;
  gguf_file: string;
}

interface DownloadProgressInfo {
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
}

interface BuiltInModelManagerProps {
  selectedModel: string;
  onModelSelect: (model: string) => void;
  layout?: 'inline' | 'dialog';
}

export function BuiltInModelManager({
  selectedModel,
  onModelSelect,
  layout = 'inline',
}: BuiltInModelManagerProps) {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [hasFetched, setHasFetched] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [downloadProgressInfo, setDownloadProgressInfo] = useState<Record<string, DownloadProgressInfo>>({});
  const [downloadingModels, setDownloadingModels] = useState<Set<string>>(new Set());
  const [addDialogOpen, setAddDialogOpen] = useState<boolean>(false);

  const fetchModels = async () => {
    try {
      setIsLoading(true);
      const data = (await invoke('builtin_ai_list_models')) as ModelInfo[];
      setModels(data);

      // Sync downloading state from backend: if backend reports a model as
      // downloading (including stuck/phantom states), track it locally so the
      // UI shows the progress bar + cancel button instead of no buttons at all.
      const backendDownloading = data.filter((m) => m.status.type === 'downloading');
      if (backendDownloading.length > 0) {
        setDownloadingModels((prev) => {
          let changed = false;
          const newSet = new Set(prev);
          for (const m of backendDownloading) {
            if (!newSet.has(m.name)) {
              newSet.add(m.name);
              changed = true;
            }
          }
          return changed ? newSet : prev;
        });
        // Seed progress from backend status so the progress bar renders
        setDownloadProgress((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const m of backendDownloading) {
            if (next[m.name] === undefined) {
              next[m.name] = m.status.progress ?? 0;
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }

      // Auto-select first available model if none selected
      if (data.length > 0 && !selectedModel) {
        const firstAvailable = data.find((m) => m.status.type === 'available');
        if (firstAvailable) {
          onModelSelect(firstAvailable.name);
        }
      }
    } catch (error) {
      console.error('Failed to fetch built-in AI models:', error);
      toast.error(i18n.t('toasts.loadModelsFailedShort'));
    } finally {
      setIsLoading(false);
      setHasFetched(true);
    }
  };

  useEffect(() => {
    fetchModels();
  }, []);

  // Listen for download progress events
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupListener = async () => {
      unlisten = await listen('builtin-ai-download-progress', (event: any) => {
        const { model, progress, downloaded_mb, total_mb, speed_mbps, status, error } = event.payload;

        // Update percentage progress
        setDownloadProgress((prev) => ({
          ...prev,
          [model]: progress,
        }));

        // Update detailed progress info (MB, speed)
        setDownloadProgressInfo((prev) => ({
          ...prev,
          [model]: {
            downloadedMb: downloaded_mb ?? 0,
            totalMb: total_mb ?? 0,
            speedMbps: speed_mbps ?? 0,
          },
        }));

        // Handle downloading status - restore downloadingModels state on modal reopen
        if (status === 'downloading') {
          setDownloadingModels((prev) => {
            if (!prev.has(model)) {
              const newSet = new Set(prev);
              newSet.add(model);
              return newSet;
            }
            return prev;
          });
        }

        // Handle completed status
        if (status === 'completed') {
          setDownloadingModels((prev) => {
            const newSet = new Set(prev);
            newSet.delete(model);
            return newSet;
          });
          // Clean up progress state
          setDownloadProgress((prev) => {
            const { [model]: _, ...rest } = prev;
            return rest;
          });
          setDownloadProgressInfo((prev) => {
            const { [model]: _, ...rest } = prev;
            return rest;
          });
          // Refresh models list
          fetchModels();
          toast.success(i18n.t('toasts.modelDownloadedName', { name: model }));
        }

        // Handle cancelled status
        if (status === 'cancelled') {
          setDownloadingModels((prev) => {
            const newSet = new Set(prev);
            newSet.delete(model);
            return newSet;
          });
          // Clean up progress state
          setDownloadProgress((prev) => {
            const { [model]: _, ...rest } = prev;
            return rest;
          });
          setDownloadProgressInfo((prev) => {
            const { [model]: _, ...rest } = prev;
            return rest;
          });
          // Refresh models list
          fetchModels();
        }

        // Handle error status
        if (status === 'error') {
          setDownloadingModels((prev) => {
            const newSet = new Set(prev);
            newSet.delete(model);
            return newSet;
          });
          // Clean up progress state
          setDownloadProgress((prev) => {
            const { [model]: _, ...rest } = prev;
            return rest;
          });
          setDownloadProgressInfo((prev) => {
            const { [model]: _, ...rest } = prev;
            return rest;
          });

          // Update model status to error locally instead of fetching from backend
          setModels((prevModels) =>
            prevModels.map((m) =>
              m.name === model
                ? {
                    ...m,
                    status: {
                      type: 'error',
                      progress: 0,
                      message: error,
                    } as any,
                  }
                : m
            )
          );

          // Don't show error toast here - DownloadProgressToast already handles it
          // Don't call fetchModels() - it would overwrite error status with not_downloaded
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const downloadModel = async (modelName: string) => {
    try {
      // Optimistically add to downloadingModels for immediate UI feedback
      setDownloadingModels((prev) => new Set([...prev, modelName]));

      await invoke('builtin_ai_download_model', { modelName });
    } catch (error) {
      console.error('Failed to download model:', error);

      // Check if this is a cancellation error (starts with "CANCELLED:")
      const errorMsg = String(error);
      if (errorMsg.startsWith('CANCELLED:')) {
        // Cancel handler already removed from downloadingModels
        // Don't show error toast for cancellations - cancel function already shows info toast
        return;
      }

      // For real errors, show toast and remove from downloading
      toast.error(i18n.t('toasts.downloadModelFailed', { name: modelName }));

      setDownloadingModels((prev) => {
        const newSet = new Set(prev);
        newSet.delete(modelName);
        return newSet;
      });

      // Update model status to error locally instead of calling fetchModels(),
      // keeping the error message visible so the user can retry via the download button.
      setModels((prevModels) =>
        prevModels.map((m) =>
          m.name === modelName
            ? {
                ...m,
                status: {
                  type: 'error',
                  progress: 0,
                  message: errorMsg,
                } as any,
              }
            : m
        )
      );
    }
  };

  const cancelDownload = async (modelName: string) => {
    try {
      await invoke('builtin_ai_cancel_download', { modelName });
      toast.info(i18n.t('toasts.downloadCancelled', { name: modelName }));
      setDownloadingModels((prev) => {
        const newSet = new Set(prev);
        newSet.delete(modelName);
        return newSet;
      });
    } catch (error) {
      console.error('Failed to cancel download:', error);
    }
  };

  const deleteModel = async (modelName: string) => {
    try {
      await invoke('builtin_ai_delete_model', { modelName });
      toast.success(i18n.t('toasts.modelDeleted', { name: modelName }));
      // If the deleted model was the selected one, fall back to another
      // available model (or clear the selection) so config never points at
      // a missing model.
      if (selectedModel === modelName) {
        const fallback = models.find(
          (m) => m.name !== modelName && m.status.type === 'available'
        );
        onModelSelect(fallback ? fallback.name : '');
      }
      fetchModels();
    } catch (error) {
      console.error('Failed to delete model:', error);
      toast.error(i18n.t('toasts.deleteModelFailed', { name: modelName }));
    }
  };

  const deleteCustomModel = async (modelName: string) => {
    try {
      await invoke('builtin_ai_delete_custom_model', { modelName });
      toast.success(i18n.t('toasts.modelDeleted', { name: modelName }));
      fetchModels();
    } catch (error) {
      console.error('Failed to delete custom model:', error);
      toast.error(i18n.t('toasts.deleteModelFailed', { name: modelName }));
    }
  };

  // Split models into built-in and custom for separate sections
  const builtInModels = models.filter((m) => !m.name.startsWith('custom:'));
  const customModels = models.filter((m) => m.name.startsWith('custom:'));

  // Don't show loading spinner if we have downloads in progress - show the model list instead
  if (isLoading && downloadingModels.size === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <RefreshCw className="mx-auto h-8 w-8 animate-spin mb-2" />
        {t('builtinModels.loading')}
      </div>
    );
  }

  // Only show "no models" message after fetch has completed
  if (hasFetched && models.length === 0) {
    return (
      <Alert>
        <AlertDescription>
          {t('builtinModels.noModels')}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-bold">{t('builtinModels.title')}</h4>
      </div>

      <div
        className={cn(
          'grid gap-4',
          layout === 'dialog' && 'pb-2'
        )}
      >
        {builtInModels.map((model) => {
          const progress = downloadProgress[model.name];
          const progressInfo = downloadProgressInfo[model.name];
          const modelIsDownloading = downloadingModels.has(model.name);
          const isAvailable = model.status.type === 'available';
          const isNotDownloaded = model.status.type === 'not_downloaded';
          const isCorrupted = model.status.type === 'corrupted';
          const isError = model.status.type === 'error';

          return (
            <div
              key={model.name}
              className={cn(
                'p-4 rounded-lg border transition-colors',
                modelIsDownloading
                  ? 'bg-white border-gray-200'
                  : 'bg-card',
                selectedModel === model.name
                  ? 'ring-2 ring-gray-800 border-gray-800'
                  : 'border-gray-200 hover:border-gray-300',
                isAvailable && !modelIsDownloading && 'cursor-pointer'
              )}
              onClick={() => {
                if (isAvailable && !modelIsDownloading) {
                  onModelSelect(model.name);
                }
              }}
            >
            <div className="space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-words text-base font-bold leading-snug text-gray-900">{t(`builtinModels.names.${modelNameKey(model.name)}`, { defaultValue: model.display_name || model.name })}</span>
                    {isAvailable && (
                      <>
                        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-green-600">
                          <span className="h-2 w-2 rounded-full bg-green-600"></span>
                          {t('builtinModels.ready')}
                        </span>
                        {selectedModel === model.name && (
                          <span className="shrink-0 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                            {t('builtinModels.selected')}
                          </span>
                        )}
                      </>
                    )}
                    {isCorrupted && (
                      <span className="flex shrink-0 items-center gap-1 rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        <BadgeAlert className="h-3 w-3" />
                        {t('builtinModels.corrupted')}
                      </span>
                    )}
                    {isError && (
                      <span className="shrink-0 rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        {t('builtinModels.error')}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:ml-4 sm:w-auto sm:justify-end">
                  {/* Not Downloaded - Show Download button */}
                  {isNotDownloaded && !modelIsDownloading && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-w-[100px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        downloadModel(model.name);
                      }}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      {t('common.download')}
                    </Button>
                  )}
                  {/* Downloading - Show Cancel button */}
                  {modelIsDownloading && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-w-[100px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        cancelDownload(model.name);
                      }}
                    >
                      {t('common.cancel')}
                    </Button>
                  )}
                  {/* Error - Show Download button (retry download) */}
                  {isError && !modelIsDownloading && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="min-w-[100px]"
                      onClick={(e) => {
                        e.stopPropagation();
                        downloadModel(model.name);
                      }}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      {t('common.download')}
                    </Button>
                  )}
                  {/* Corrupted - Show both Retry and Delete buttons */}
                  {isCorrupted && !modelIsDownloading && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          downloadModel(model.name);
                        }}
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        {t('common.retry')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteModel(model.name);
                        }}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        {t('common.delete')}
                      </Button>
                    </>
                  )}
                  {/* Available - Delete button (file can be re-downloaded later) */}
                  {isAvailable && !modelIsDownloading && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteModel(model.name);
                      }}
                      title={t('builtinModels.deleteModel')}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {t('common.delete')}
                    </Button>
                  )}
                </div>
              </div>
              <div className="text-sm text-gray-600">
                {model.description && (
                  <p className="mb-1">{t(`builtinModels.descriptions.${modelNameKey(model.name)}`, { defaultValue: model.description })}</p>
                )}
                {(isError || isCorrupted) && (
                  <p className="mb-1 text-xs text-red-600">
                    {isError
                      ? model.status.message || t('builtinModels.errorOccurred')
                      : t('builtinModels.corruptedHint')}
                  </p>
                )}
                <div className="text-xs text-gray-500">
                  <span>{t('builtinModels.tokensSpec', { size: formatSummaryModelSizeLabelFromMb(model.size_mb), tokens: model.context_size })}</span>
                </div>
                </div>
              </div>

              {/* Download progress bar */}
              {modelIsDownloading && progress !== undefined && (
                <div className="mt-3 pt-3 border-t border-gray-200">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-gray-900">{t('builtinModels.downloading')}</span>
                    <span className="text-sm font-semibold text-gray-900">
                      {Math.round(progress)}%
                    </span>
                  </div>
                  <div className="text-sm text-gray-600 mb-2">
                    {progressInfo?.totalMb > 0 ? (
                      <>
                        {progressInfo.downloadedMb.toFixed(1)} MiB / {progressInfo.totalMb.toFixed(1)} MiB
                        {progressInfo.speedMbps > 0 && (
                          <span className="ml-2 text-gray-500">
                            ({progressInfo.speedMbps.toFixed(1)} MiB/s)
                          </span>
                        )}
                      </>
                    ) : (
                      <span>{formatSummaryModelSizeLabelFromMb(model.size_mb)}</span>
                    )}
                  </div>
                  <div className="w-full h-2.5 bg-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-gray-800 to-gray-900 rounded-full transition-all duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Custom models section */}
      <div className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-bold">自定义模型</h4>
          <Button variant="outline" size="sm" onClick={() => setAddDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            添加模型
          </Button>
        </div>

        {customModels.length === 0 ? (
          <p className="text-sm text-gray-500 py-2">
            暂无自定义模型。可添加任意 GGUF 格式模型（如其他 Qwen / Gemma / Llama 变体）。
          </p>
        ) : (
          <div className="grid gap-4">
            {customModels.map((model) => {
              const isAvailable = model.status.type === 'available';
              return (
                <div
                  key={model.name}
                  className={cn(
                    'p-4 rounded-lg border transition-colors bg-card',
                    selectedModel === model.name
                      ? 'ring-2 ring-gray-800 border-gray-800'
                      : 'border-gray-200 hover:border-gray-300',
                    isAvailable && 'cursor-pointer'
                  )}
                  onClick={() => {
                    if (isAvailable) {
                      onModelSelect(model.name);
                    }
                  }}
                >
                  <div className="space-y-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="min-w-0 break-words text-base font-bold leading-snug text-gray-900">
                            {model.display_name || model.name}
                          </span>
                          {isAvailable && (
                            <>
                              <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-green-600">
                                <span className="h-2 w-2 rounded-full bg-green-600"></span>
                                {t('builtinModels.ready')}
                              </span>
                              {selectedModel === model.name && (
                                <span className="shrink-0 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
                                  {t('builtinModels.selected')}
                                </span>
                              )}
                            </>
                          )}
                          {model.status.type === 'error' && (
                            <span className="shrink-0 rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                              {t('builtinModels.error')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex w-full shrink-0 items-center gap-2 sm:ml-4 sm:w-auto sm:justify-end">
                        {selectedModel !== model.name && (
                          <button
                            className="p-2 rounded hover:bg-gray-100 transition-colors text-gray-500 hover:text-red-600"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteCustomModel(model.name);
                            }}
                            title={t('builtinModels.deleteModel')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="text-sm text-gray-600">
                      {model.description && <p className="mb-1">{model.description}</p>}
                      {model.status.type === 'error' && (
                        <p className="mb-1 text-xs text-red-600">
                          {model.status.message || t('builtinModels.errorOccurred')}
                        </p>
                      )}
                      <div className="text-xs text-gray-500">
                        <span>
                          {t('builtinModels.tokensSpec', {
                            size: formatSummaryModelSizeLabelFromMb(model.size_mb),
                            tokens: model.context_size,
                          })}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add custom model wizard */}
      <AddCustomModelDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onAdded={() => fetchModels()}
      />
    </div>
  );
}
