import React, { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import i18n from '@/lib/i18n/config';
import { Plus } from 'lucide-react';
import {
  SenseVoiceModelInfo,
  SenseVoiceModelStatus,
  SenseVoiceAPI,
  getSenseVoiceModelDisplayInfo,
  getSenseVoiceModelDisplayName,
  getSenseVoiceDownloadProgress
} from '../lib/sensevoice';
import { formatFileSize } from '../lib/parakeet';
import { AddCustomAsrModelDialog } from './AddCustomAsrModelDialog';

interface SenseVoiceModelManagerProps {
  selectedModel?: string;
  onModelSelect?: (modelName: string) => void | Promise<void>;
  className?: string;
  autoSave?: boolean;
}

export function SenseVoiceModelManager({
  selectedModel,
  onModelSelect,
  className = '',
  autoSave = false
}: SenseVoiceModelManagerProps) {
  const { t } = useTranslation();
  const [models, setModels] = useState<SenseVoiceModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [downloadingModels, setDownloadingModels] = useState<Set<string>>(new Set());
  const [addCustomDialogOpen, setAddCustomDialogOpen] = useState(false);

  // Refs for stable callbacks
  const onModelSelectRef = useRef(onModelSelect);
  const autoSaveRef = useRef(autoSave);

  // Progress throttle map to prevent rapid updates
  const progressThrottleRef = useRef<Map<string, { progress: number; timestamp: number }>>(new Map());

  useEffect(() => {
    onModelSelectRef.current = onModelSelect;
    autoSaveRef.current = autoSave;
  }, [onModelSelect, autoSave]);

  // Initialize and load models
  useEffect(() => {
    if (initialized) return;

    const initializeModels = async () => {
      try {
        setLoading(true);
        await SenseVoiceAPI.init();
        const modelList = await SenseVoiceAPI.getAvailableModels();
        setModels(modelList);
        setInitialized(true);
      } catch (err) {
        console.error('Failed to initialize SenseVoice:', err);
        setError(err instanceof Error ? err.message : i18n.t('toasts.loadModelsFailedShort'));
        toast.error(i18n.t('toasts.loadModelsFailed'), {
          description: err instanceof Error ? err.message : i18n.t('toasts.unknownError'),
          duration: 5000
        });
      } finally {
        setLoading(false);
      }
    };

    initializeModels();
  }, [initialized]);

  // Set up event listeners for download progress
  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenComplete: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;

    const setupListeners = async () => {
      // Download progress with throttling
      unlistenProgress = await listen<{ modelName: string; progress: number; downloaded_mb?: number; total_mb?: number; status?: string }>(
        'sensevoice-model-download-progress',
        (event) => {
          const { modelName, progress, downloaded_mb, total_mb, status } = event.payload;

          if (status === 'cancelled') {
            setModels(prevModels =>
              prevModels.map(model =>
                model.name === modelName
                  ? { ...model, status: 'Missing' as SenseVoiceModelStatus }
                  : model
              )
            );
            progressThrottleRef.current.delete(modelName);
            return;
          }

          // Extraction phase (tarball models): keep the card in downloading
          // state with an explicit "extracting" label instead of a fake 100%.
          if (status === 'extracting') {
            setModels(prevModels =>
              prevModels.map(model =>
                model.name === modelName
                  ? { ...model, status: { Downloading: { progress: 100, extracting: true } } as SenseVoiceModelStatus }
                  : model
              )
            );
            return;
          }

          // Terminal progress event: treat as completed so the card never
          // sticks at "downloading 100%" even if the complete event is lost.
          if (status === 'completed' || progress >= 100) {
            setModels(prevModels =>
              prevModels.map(model =>
                model.name === modelName
                  ? { ...model, status: 'Available' as SenseVoiceModelStatus }
                  : model
              )
            );
            setDownloadingModels(prev => {
              const newSet = new Set(prev);
              newSet.delete(modelName);
              return newSet;
            });
            progressThrottleRef.current.delete(modelName);
            return;
          }

          const now = Date.now();
          const throttleData = progressThrottleRef.current.get(modelName);

          // Throttle: only update if 300ms passed OR progress jumped by 5%+
          const shouldUpdate = !throttleData ||
            now - throttleData.timestamp > 300 ||
            Math.abs(progress - throttleData.progress) >= 5;

          if (shouldUpdate) {
            progressThrottleRef.current.set(modelName, { progress, timestamp: now });

            setModels(prevModels =>
              prevModels.map(model =>
                model.name === modelName
                  ? { ...model, status: { Downloading: { progress, downloadedMb: downloaded_mb, totalMb: total_mb } } as SenseVoiceModelStatus }
                  : model
              )
            );
          }
        }
      );

      // Download complete
      unlistenComplete = await listen<{ modelName: string }>(
        'sensevoice-model-download-complete',
        async (event) => {
          const { modelName } = event.payload;
          const displayInfo = getSenseVoiceModelDisplayInfo(modelName);
          const displayName = displayInfo?.friendlyName || modelName;

          // Custom (user-imported) models are not in the list yet: refresh.
          if (modelName.startsWith('custom:')) {
            try {
              const modelList = await SenseVoiceAPI.getAvailableModels();
              setModels(modelList);
            } catch (err) {
              console.error('Failed to refresh models after custom import:', err);
            }
            return;
          }

          setModels(prevModels =>
            prevModels.map(model =>
              model.name === modelName
                ? { ...model, status: 'Available' as SenseVoiceModelStatus }
                : model
            )
          );

          setDownloadingModels(prev => {
            const newSet = new Set(prev);
            newSet.delete(modelName);
            return newSet;
          });

          progressThrottleRef.current.delete(modelName);

          toast.success(`${displayInfo?.icon || '✓'} ${i18n.t('toasts.whisperModelReady', { name: displayName })}`, {
            description: i18n.t('toasts.whisperModelReadyDesc'),
            duration: 4000
          });

          // Auto-select after download using stable refs
          if (onModelSelectRef.current) {
            try {
              await onModelSelectRef.current(modelName);
              if (autoSaveRef.current) await saveModelSelection(modelName);
            } catch (err) {
              toast.error('识别模型设置保存失败', { description: String(err) });
            }
          }
        }
      );

      // Download error
      unlistenError = await listen<{ modelName: string; error: string }>(
        'sensevoice-model-download-error',
        (event) => {
          const { modelName, error } = event.payload;
          const displayName = getSenseVoiceModelDisplayName(modelName);

          setModels(prevModels =>
            prevModels.map(model =>
              model.name === modelName
                ? { ...model, status: 'Missing' as SenseVoiceModelStatus }
                : model
            )
          );

          setDownloadingModels(prev => {
            const newSet = new Set(prev);
            newSet.delete(modelName);
            return newSet;
          });

          progressThrottleRef.current.delete(modelName);

          toast.error(i18n.t('toasts.downloadModelFailed', { name: displayName }), {
            description: error,
            duration: 6000,
            action: {
              label: i18n.t('whisperModels.retry'),
              onClick: () => downloadModel(modelName)
            }
          });
        }
      );
    };

    setupListeners();

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenComplete) unlistenComplete();
      if (unlistenError) unlistenError();
    };
  }, []); // Empty dependency array - listeners use refs for stable callbacks

  const saveModelSelection = async (modelName: string) => {
    try {
      await invoke('api_save_transcript_config', {
        provider: 'sensevoice',
        model: modelName,
        apiKey: null
      });
    } catch (error) {
      console.error('Failed to save model selection:', error);
    }
  };

  const cancelDownload = async (modelName: string) => {
    const displayName = getSenseVoiceModelDisplayName(modelName);

    try {
      await SenseVoiceAPI.cancelDownload(modelName);

      setDownloadingModels(prev => {
        const newSet = new Set(prev);
        newSet.delete(modelName);
        return newSet;
      });

      setModels(prevModels =>
        prevModels.map(model =>
          model.name === modelName
            ? { ...model, status: 'Missing' as SenseVoiceModelStatus }
            : model
        )
      );

      progressThrottleRef.current.delete(modelName);

      toast.info(i18n.t('toasts.downloadCancelled', { name: displayName }), {
        duration: 3000
      });
    } catch (err) {
      console.error('Failed to cancel download:', err);
      toast.error(i18n.t('toasts.cancelDownloadFailed'), {
        description: err instanceof Error ? err.message : i18n.t('toasts.unknownError'),
        duration: 4000
      });
    }
  };

  const downloadModel = async (modelName: string) => {
    if (downloadingModels.has(modelName)) return;

    const displayName = getSenseVoiceModelDisplayName(modelName);

    try {
      setDownloadingModels(prev => new Set([...prev, modelName]));

      setModels(prevModels =>
        prevModels.map(model =>
          model.name === modelName
            ? { ...model, status: { Downloading: { progress: 0 } } as SenseVoiceModelStatus }
            : model
        )
      );

      toast.info(i18n.t('toasts.downloadingModel', { name: displayName }), {
        description: i18n.t('toasts.downloadingModelDesc'),
        duration: 5000
      });

      await SenseVoiceAPI.downloadModel(modelName);

      // The command resolved successfully: force the card out of the
      // downloading state regardless of event delivery order.
      setDownloadingModels(prev => {
        const newSet = new Set(prev);
        newSet.delete(modelName);
        return newSet;
      });
      progressThrottleRef.current.delete(modelName);
      setModels(prev =>
        prev.map(model =>
          model.name === modelName ? { ...model, status: 'Available' as SenseVoiceModelStatus } : model
        )
      );
    } catch (err) {
      console.error('Download failed:', err);
      setDownloadingModels(prev => {
        const newSet = new Set(prev);
        newSet.delete(modelName);
        return newSet;
      });

      setModels(prev =>
        prev.map(model =>
          model.name === modelName ? { ...model, status: 'Missing' as SenseVoiceModelStatus } : model
        )
      );
    }
  };

  const selectModel = async (modelName: string) => {
    try {
      await onModelSelect?.(modelName);
      if (autoSave) await saveModelSelection(modelName);
      const displayName = getSenseVoiceModelDisplayName(modelName);
      toast.success(i18n.t('toasts.switchedTo', { name: displayName }), { duration: 3000 });
    } catch (err) {
      toast.error('识别模型设置保存失败', { description: String(err) });
    }
  };

  const deleteModel = async (modelName: string) => {
    const displayName = getSenseVoiceModelDisplayName(modelName);

    try {
      await SenseVoiceAPI.deleteModel(modelName);

      // Refresh models list
      const modelList = await SenseVoiceAPI.getAvailableModels();
      setModels(modelList);

      toast.success(i18n.t('toasts.modelDeleted', { name: displayName }), {
        description: i18n.t('toasts.modelDeletedDesc'),
        duration: 3000
      });

      // If deleted model was selected, clear selection
      if (selectedModel === modelName && onModelSelect) {
        await onModelSelect('');
      }
    } catch (err) {
      console.error('Failed to delete model:', err);
      toast.error(i18n.t('toasts.deleteModelFailed', { name: displayName }), {
        description: err instanceof Error ? err.message : i18n.t('toasts.deleteFailed'),
        duration: 4000
      });
    }
  };

  if (loading) {
    return (
      <div className={`space-y-3 ${className}`}>
        <div className="animate-pulse space-y-3">
          <div className="h-20 bg-gray-100 rounded-lg"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`bg-red-50 border border-red-200 rounded-lg p-4 ${className}`}>
        <p className="text-sm text-red-800">{t('whisperModels.loadFailed')}</p>
        <p className="text-xs text-red-600 mt-1">{error}</p>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {models.filter(m => !m.name.startsWith('custom:')).map(model => (
        <ModelCard
          key={model.name}
          model={model}
          isSelected={selectedModel === model.name}
          onSelect={() => {
            if (model.status === 'Available') {
              selectModel(model.name);
            }
          }}
          onDownload={() => downloadModel(model.name)}
          onCancel={() => cancelDownload(model.name)}
          onDelete={() => deleteModel(model.name)}
        />
      ))}

      {/* Custom (user-imported local) models */}
      <div className="pt-2">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-gray-700">{t('customAsr.title')}</h4>
          <button
            onClick={() => setAddCustomDialogOpen(true)}
            className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('customAsr.add')}
          </button>
        </div>

        {models.filter(m => m.name.startsWith('custom:')).length === 0 ? (
          <p className="text-xs text-gray-500 py-1">{t('customAsr.empty')}</p>
        ) : (
          <div className="space-y-2">
            {models.filter(m => m.name.startsWith('custom:')).map(model => {
              const isAvailable = model.status === 'Available';
              const isSelected = selectedModel === model.name;
              return (
                <div
                  key={model.name}
                  onClick={() => {
                    if (isAvailable) selectModel(model.name);
                  }}
                  className={`relative rounded-lg border-2 p-3 transition-all ${
                    isSelected && isAvailable
                      ? 'border-blue-500 bg-blue-50 cursor-pointer'
                      : isAvailable
                        ? 'border-gray-200 hover:border-gray-300 bg-white cursor-pointer'
                        : 'border-red-200 bg-red-50 cursor-default'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xl">📁</span>
                        <h3 className="font-semibold text-gray-900 truncate">{model.display_name}</h3>
                        {isSelected && isAvailable && (
                          <span className="bg-blue-600 text-white px-2 py-0.5 rounded-full text-xs font-medium">✓</span>
                        )}
                      </div>
                      {model.note && (
                        <p className="text-xs text-gray-600 ml-8 mt-0.5">{model.note}</p>
                      )}
                      <p className="text-xs text-gray-400 ml-8 mt-0.5">
                        {isAvailable
                          ? `${t('whisperModels.ready')} • ${formatFileSize(model.size_mb)}`
                          : t('customAsr.incomplete')}
                      </p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteModel(model.name);
                      }}
                      className="text-gray-400 hover:text-red-600 transition-colors p-1 flex-shrink-0"
                      title={t('whisperModels.deleteToFree')}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Helper text */}
      {selectedModel && (
        <motion.div
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-xs text-gray-500 text-center pt-2"
        >
          {t('whisperModels.usingModel', { name: models.find(m => m.name === selectedModel)?.display_name || getSenseVoiceModelDisplayName(selectedModel) })}
        </motion.div>
      )}

      <AddCustomAsrModelDialog
        open={addCustomDialogOpen}
        onClose={() => setAddCustomDialogOpen(false)}
        onAdded={async () => {
          try {
            const modelList = await SenseVoiceAPI.getAvailableModels();
            setModels(modelList);
          } catch (err) {
            console.error('Failed to refresh models:', err);
          }
        }}
      />
    </div>
  );
}

// Model Card Component
interface ModelCardProps {
  model: SenseVoiceModelInfo;
  isSelected: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

function ModelCard({
  model,
  isSelected,
  onSelect,
  onDownload,
  onCancel,
  onDelete
}: ModelCardProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const displayInfo = getSenseVoiceModelDisplayInfo(model.name);
  const displayName = displayInfo?.friendlyName || model.display_name || model.name;
  const icon = displayInfo?.icon || '🎙️';
  const tagline = displayInfo?.tagline || model.note || '';

  const isAvailable = model.status === 'Available';
  const isMissing = model.status === 'Missing';
  const downloadProgress = getSenseVoiceDownloadProgress(model.status);
  // Actual download byte counters streamed from the backend (same source as
  // the global download toast), so both surfaces show identical sizes.
  const downloading = typeof model.status === 'object' && 'Downloading' in model.status
    ? model.status.Downloading
    : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`
        relative rounded-lg border-2 transition-all cursor-pointer
        ${isSelected && isAvailable
          ? 'border-blue-500 bg-blue-50'
          : isAvailable
            ? 'border-gray-200 hover:border-gray-300 bg-white'
            : 'border-gray-200 bg-gray-50'
        }
        ${isAvailable ? '' : 'cursor-default'}
      `}
      onClick={() => {
        if (isAvailable) onSelect();
      }}
    >
      <div className="p-4">
        <div className="flex items-start justify-between mb-3">
          <div className="flex-1">
            {/* Model Name */}
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xl">{icon}</span>
              <h3 className="font-semibold text-gray-900">{displayName}</h3>
              {isSelected && isAvailable && (
                <motion.span
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  className="bg-blue-600 text-white px-2 py-0.5 rounded-full text-xs font-medium flex items-center gap-1"
                >
                  ✓
                </motion.span>
              )}
            </div>

            {/* Tagline */}
            <p className="text-sm text-gray-600 ml-9">{tagline}</p>
          </div>

          {/* Status/Action */}
          <div className="ml-4 flex items-center gap-2">
            {isAvailable && (
              <>
                <div className="flex items-center gap-1.5 text-green-600">
                  <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                  <span className="text-xs font-medium">{t('whisperModels.ready')}</span>
                </div>
                <AnimatePresence>
                  {isHovered && (
                    <motion.button
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.15 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete();
                      }}
                      className="text-gray-400 hover:text-red-600 transition-colors p-1"
                      title={t('whisperModels.deleteToFree')}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </motion.button>
                  )}
                </AnimatePresence>
              </>
            )}

            {isMissing && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDownload();
                }}
                className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                {t('whisperModels.download')}
              </button>
            )}
          </div>
        </div>

        {/* Full-width Download Progress Bar */}
        {downloadProgress !== null && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3 pt-3 border-t border-gray-200"
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-blue-600">
                  {downloading?.extracting ? t('whisperModels.extracting') : t('whisperModels.downloading')}
                </span>
                {!downloading?.extracting && (
                  <span className="text-sm font-semibold text-blue-600">{Math.round(downloadProgress)}%</span>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCancel();
                }}
                className="text-xs text-gray-600 hover:text-red-600 font-medium transition-colors px-2 py-1 rounded hover:bg-red-50"
                title={t('whisperModels.cancelDownload')}
              >
                {t('whisperModels.cancel')}
              </button>
            </div>
            <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
              <motion.div
                className="h-full bg-gradient-to-r from-blue-500 to-blue-600 rounded-full"
                initial={{ width: 0 }}
                animate={{ width: `${downloadProgress}%` }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {downloading && downloading.totalMb ? (
                <>
                  {(downloading.downloadedMb ?? 0).toFixed(1)} / {downloading.totalMb.toFixed(1)} MB
                </>
              ) : model.size_mb ? (
                <>
                  {formatFileSize(model.size_mb * downloadProgress / 100)} / {formatFileSize(model.size_mb)}
                </>
              ) : (
                t('whisperModels.downloading')
              )}
            </p>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
