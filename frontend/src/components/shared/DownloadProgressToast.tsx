'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { X, Download, Check, Loader2, ArrowBigDownDash } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getDownloadTotalMb } from '@/lib/onboarding-summary-model';

interface DownloadProgress {
  modelName: string;
  displayName: string;
  progress: number;
  downloadedMb: number;
  totalMb: number;
  speedMbps: number;
  status: 'downloading' | 'completed' | 'error' | 'cancelled';
  unitLabel?: string;
  extracting?: boolean;
  error?: string;
}

// Categorize error messages for better user experience
function categorizeError(error: string): string {
  const lowerError = error.toLowerCase();

  if (lowerError.includes('network') ||
    lowerError.includes('connection') ||
    lowerError.includes('timeout') ||
    lowerError.includes('failed to start download')) {
    return 'downloadToast.errNetwork';
  }

  if (lowerError.includes('status:') || lowerError.includes('http')) {
    return 'downloadToast.errServer';
  }

  if (lowerError.includes('disk') ||
    lowerError.includes('write') ||
    lowerError.includes('file')) {
    return 'downloadToast.errStorage';
  }

  if (lowerError.includes('invalid') || lowerError.includes('validation')) {
    return 'downloadToast.errValidation';
  }

  // Fallback to original error
  return error;
}

// Custom toast component for download progress
function DownloadToastContent({
  download,
  onDismiss,
}: {
  download: DownloadProgress;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  const isComplete = download.status === 'completed';
  const hasError = download.status === 'error';
  const isCancelled = download.status === 'cancelled';
  const unitLabel = download.unitLabel ?? 'MB';

  return (
    <div className="flex items-center gap-3 w-full max-w-sm bg-white rounded-lg shadow-lg border border-gray-200 p-3 relative">

      {/* Close button */}
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="absolute top-1.5 right-1.5 p-1 text-gray-400 hover:text-gray-600 rounded transition-colors"
          aria-label="close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Icon */}
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${isComplete ? 'bg-green-100' : hasError ? 'bg-red-100' : isCancelled ? 'bg-gray-100' : 'bg-gray-100'
        }`}>
        {isComplete ? (
          <Check className="w-4 h-4 text-green-600" />
        ) : hasError ? (
          <X className="w-4 h-4 text-red-600" />
        ) : isCancelled ? (
          <X className="w-4 h-4 text-gray-600" />
        ) : (
          <ArrowBigDownDash className="size-5 text-gray-600 " />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2 mb-1">
          <p className="text-sm font-medium text-gray-900 truncate">
            {download.displayName}
          </p>
        </div>

        {hasError ? (
          <p className="text-xs text-red-600">{t(download.error || 'downloadToast.failed')}</p>
        ) : isComplete ? (
          <p className="text-xs text-green-600">{t('downloadToast.complete')}</p>
        ) : isCancelled ? (
          <p className="text-xs text-gray-600">{t('downloadToast.cancelled')}</p>
        ) : (
          <>
            {/* Progress bar */}
            <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden mb-1.5">
              <div
                className="h-full bg-gray-900 rounded-full transition-all duration-300"
                style={{ width: `${download.progress}%` }}
              />
            </div>

            {/* Progress text */}
            <div className="flex items-center justify-between text-xs text-gray-500">
              <span>
                {download.downloadedMb.toFixed(1)} / {download.totalMb.toFixed(1)} {unitLabel}
              </span>
              {download.extracting ? (
                <span className="text-gray-900 font-medium">{t('downloadToast.extracting')}</span>
              ) : (
                <span className="flex items-center gap-1">
                  {download.speedMbps > 0 && (
                    <span>{download.speedMbps.toFixed(1)} {unitLabel}/s</span>
                  )}
                  <span className="text-gray-900 font-medium">
                    {Math.round(download.progress)}%
                  </span>
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Hook to manage download progress toasts
export function useDownloadProgressToast() {
  const { t } = useTranslation();
  const [downloads, setDownloads] = useState<Map<string, DownloadProgress>>(new Map());
  const [dismissedModels, setDismissedModels] = useState<Set<string>>(new Set());

  const updateDownload = useCallback((modelName: string, data: Partial<DownloadProgress>) => {
    setDownloads((prev) => {
      const updated = new Map(prev);
      const existing = updated.get(modelName) || {
        modelName,
        displayName: modelName,
        progress: 0,
        downloadedMb: 0,
        totalMb: 0,
        speedMbps: 0,
        status: 'downloading' as const,
      };

      updated.set(modelName, { ...existing, ...data });
      return updated;
    });
  }, []);

  const cleanupDownload = useCallback((modelName: string, delay: number = 4000) => {
    // Remove download from map after delay (allows toast to show and auto-dismiss)
    setTimeout(() => {
      setDownloads((prev) => {
        const updated = new Map(prev);
        updated.delete(modelName);
        return updated;
      });
    }, delay);
  }, []);

  const showDownloadToast = useCallback((download: DownloadProgress) => {
    const toastId = `download-${download.modelName}`;

    // Determine duration based on status
    const getDuration = () => {
      switch (download.status) {
        case 'completed': return 3000;      // 3 seconds
        case 'cancelled': return 5000;      // 5 seconds
        case 'error': return 10000;         // 10 seconds
        case 'downloading': return Infinity; // Manual dismiss only
      }
    };

    // Dismiss handler
    const dismissToast = () => {
      toast.dismiss(toastId);
      setDismissedModels(prev => {
        const next = new Set(prev);
        next.add(download.modelName);
        return next;
      });
    };

    toast.custom(
      (t) => (
        <DownloadToastContent
          download={download}
          onDismiss={dismissToast}
        />
      ),
      {
        position: 'top-right',
        id: toastId,
        duration: getDuration(),
      }
    );
  }, []);

  // Effect to handle toast visibility based on dismissed state.
  // Downloading toasts persist; terminal toasts (completed/cancelled/error)
  // are shown exactly once and auto-dismiss after a short delay.
  const terminalShownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    downloads.forEach((download) => {
      const name = download.modelName;

      if (download.status === 'downloading') {
        // If model was dismissed and is still downloading, don't show it
        if (dismissedModels.has(name)) return;
        showDownloadToast(download);
        return;
      }

      const key = `${name}:${download.status}`;
      if (terminalShownRef.current.has(key)) return;
      terminalShownRef.current.add(key);
      showDownloadToast(download);

      const delay = download.status === 'completed' ? 3000 : download.status === 'cancelled' ? 5000 : 10000;
      setTimeout(() => toast.dismiss(`download-${name}`), delay);
    });
  }, [downloads, dismissedModels, showDownloadToast]);

  // Listen to Parakeet download events
  useEffect(() => {
    const unlistenProgress = listen<{
      modelName: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status?: string;
    }>('parakeet-model-download-progress', (event) => {
      const { modelName, progress, downloaded_mb, total_mb, speed_mbps, status } = event.payload;

      const downloadData: DownloadProgress = {
        modelName,
        displayName: t('downloadToast.transcriptionModel', { engine: 'Parakeet' }),
        progress,
        downloadedMb: downloaded_mb ?? 0,
        totalMb: total_mb ?? 670,
        speedMbps: speed_mbps ?? 0,
        status: status === 'cancelled'
          ? 'cancelled'
          : status === 'completed' || progress >= 100
          ? 'completed'
          : 'downloading',
      };

      updateDownload(modelName, downloadData);

      // Clean up cancelled downloads after delay to auto-dismiss toast
      if (downloadData.status === 'cancelled') {
        cleanupDownload(modelName, 6000); // 5s toast + 1s buffer
      }
      // Removed direct showDownloadToast call here, handled by effect
    });

    const unlistenComplete = listen<{ modelName: string }>(
      'parakeet-model-download-complete',
      (event) => {
        const { modelName } = event.payload;
        const downloadData: DownloadProgress = {
          modelName,
          displayName: t('downloadToast.transcriptionModel', { engine: 'Parakeet' }),
          progress: 100,
          downloadedMb: 670,
          totalMb: 670,
          speedMbps: 0,
          status: 'completed',
        };
        updateDownload(modelName, downloadData);
        // Clean up after 4 seconds (completion toast duration is 3s + 1s buffer)
        cleanupDownload(modelName, 4000);
      }
    );

    const unlistenError = listen<{ modelName: string; error: string }>(
      'parakeet-model-download-error',
      (event) => {
        const { modelName, error } = event.payload;
        const downloadData: DownloadProgress = {
          modelName,
          displayName: t('downloadToast.transcriptionModel', { engine: 'Parakeet' }),
          progress: 0,
          downloadedMb: 0,
          totalMb: 670,
          speedMbps: 0,
          status: 'error',
          error: categorizeError(error),
        };
        updateDownload(modelName, downloadData);
        // Clean up after 11 seconds (error toast duration is 10s + 1s buffer)
        cleanupDownload(modelName, 11000);
      }
    );

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [updateDownload, cleanupDownload, t]);

  // Listen to SenseVoice download events (onboarding transcription engine)
  useEffect(() => {
    const unlistenProgress = listen<{
      modelName: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status?: string;
    }>('sensevoice-model-download-progress', (event) => {
      const { modelName, progress, downloaded_mb, total_mb, speed_mbps, status } = event.payload;
      const extracting = status === 'extracting';

      const downloadData: DownloadProgress = {
        modelName,
        displayName: t('downloadToast.transcriptionModel', { engine: 'SenseVoice' }),
        progress,
        downloadedMb: downloaded_mb ?? 0,
        totalMb: total_mb ?? 240,
        speedMbps: speed_mbps ?? 0,
        extracting,
        status: status === 'cancelled'
          ? 'cancelled'
          : status === 'completed' || (!extracting && progress >= 100)
          ? 'completed'
          : 'downloading',
      };

      updateDownload(modelName, downloadData);

      if (downloadData.status === 'cancelled') {
        cleanupDownload(modelName, 6000);
      }
    });

    const unlistenComplete = listen<{ modelName: string }>(
      'sensevoice-model-download-complete',
      (event) => {
        const { modelName } = event.payload;
        const downloadData: DownloadProgress = {
          modelName,
          displayName: t('downloadToast.transcriptionModel', { engine: 'SenseVoice' }),
          progress: 100,
          downloadedMb: 240,
          totalMb: 240,
          speedMbps: 0,
          status: 'completed',
        };
        updateDownload(modelName, downloadData);
        cleanupDownload(modelName, 4000);
      }
    );

    const unlistenError = listen<{ modelName: string; error: string }>(
      'sensevoice-model-download-error',
      (event) => {
        const { modelName, error } = event.payload;
        const downloadData: DownloadProgress = {
          modelName,
          displayName: t('downloadToast.transcriptionModel', { engine: 'SenseVoice' }),
          progress: 0,
          downloadedMb: 0,
          totalMb: 240,
          speedMbps: 0,
          status: 'error',
          error: categorizeError(error),
        };
        updateDownload(modelName, downloadData);
        cleanupDownload(modelName, 11000);
      }
    );

    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenComplete.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [updateDownload, cleanupDownload, t]);

  // Listen to Built-in AI summary model download events
  useEffect(() => {
    const unlisten = listen<{
      model: string;
      progress: number;
      downloaded_mb?: number;
      total_mb?: number;
      speed_mbps?: number;
      status: string;
      error?: string;
    }>('builtin-ai-download-progress', (event) => {
      const { model, progress, downloaded_mb, total_mb, speed_mbps, status, error } = event.payload;

      const downloadData: DownloadProgress = {
        modelName: model,
        displayName: t('downloadToast.summaryModel', { model }),
        progress: progress ?? 0,
        downloadedMb: downloaded_mb ?? 0,
        totalMb: getDownloadTotalMb(total_mb, model),
        speedMbps: speed_mbps ?? 0,
        unitLabel: 'MiB',
        status: status === 'completed' || progress >= 100
          ? 'completed'
          : status === 'cancelled'
            ? 'cancelled'
            : status === 'error'
              ? 'error'
              : 'downloading',
        error: status === 'error' ? categorizeError(error || 'Download failed') : undefined,
      };

      updateDownload(model, downloadData);

      // Clean up finished downloads after delay to prevent endless toasts
      if (downloadData.status === 'completed') {
        cleanupDownload(model, 4000);  // 3s toast + 1s buffer
      } else if (downloadData.status === 'error') {
        cleanupDownload(model, 11000); // 10s toast + 1s buffer
      } else if (downloadData.status === 'cancelled') {
        cleanupDownload(model, 6000);  // 5s toast + 1s buffer
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [updateDownload, cleanupDownload, t]);

  return { downloads };
}

// Component to initialize download toast listeners at app level
export function DownloadProgressToastProvider() {
  useDownloadProgressToast();
  return null;
}
