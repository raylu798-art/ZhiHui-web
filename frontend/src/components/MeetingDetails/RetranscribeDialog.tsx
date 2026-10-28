import React, { useState, useEffect, useRef, useMemo } from 'react';
import { RefreshCw, Loader2, AlertCircle, CheckCircle2, X, Cpu } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { AsrLanguageSelector } from '@/components/AsrLanguageSelector';
import { normalizeAsrLanguage } from '@/lib/asr-languages';
import { useTranscriptionModels, ModelOption } from '@/hooks/useTranscriptionModels';
import Analytics from '@/lib/analytics';
import { syncSpeakerEnabledToBackend } from '@/lib/speaker';
import { useTranslation } from 'react-i18next';

interface RetranscribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  meetingFolderPath: string | null;
  onComplete?: () => void;
}

interface RetranscriptionProgress {
  meeting_id: string;
  stage: string;
  progress_percentage: number;
  message: string;
  current?: number | null;
  total?: number | null;
}

interface RetranscriptionResult {
  meeting_id: string;
  segments_count: number;
  duration_seconds: number;
  language: string | null;
}

interface RetranscriptionError {
  meeting_id: string;
  error: string;
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function RetranscribeDialog({
  open,
  onOpenChange,
  meetingId,
  meetingFolderPath,
  onComplete,
}: RetranscribeDialogProps) {
  const { t } = useTranslation();
  const { transcriptModelConfig } = useConfig();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<RetranscriptionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedLang, setSelectedLang] = useState(transcriptModelConfig.asrLanguage || 'auto');

  // Use centralized model fetching hook
  const {
    availableModels,
    selectedModelKey,
    setSelectedModelKey,
    loadingModels,
    fetchModels,
    resetSelection,
  } = useTranscriptionModels(transcriptModelConfig);

  // Stable refs for callbacks to avoid listener re-registration
  const onCompleteRef = useRef(onComplete);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

  // Track previous open state to only reset on closed→open transition
  const prevOpenRef = useRef(false);

  // Helper to get selected model details (memoized)
  const selectedModelDetails = useMemo((): ModelOption | undefined => {
    if (!selectedModelKey) return undefined;
    const colonIndex = selectedModelKey.indexOf(':');
    if (colonIndex === -1) return undefined;
    const provider = selectedModelKey.slice(0, colonIndex);
    const name = selectedModelKey.slice(colonIndex + 1);
    return availableModels.find(m => m.provider === provider && m.name === name);
  }, [selectedModelKey, availableModels]);
  const languageForModel = normalizeAsrLanguage(selectedLang, selectedModelDetails);

  const handleModelChange = (key: string) => {
    const model = availableModels.find((item) => `${item.provider}:${item.name}` === key);
    setSelectedLang(normalizeAsrLanguage(selectedLang, model));
    setSelectedModelKey(key);
  };

  // Reset state only when dialog transitions from closed to open
  // This prevents re-initialization when config changes while dialog is already open
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      resetSelection();
      setIsProcessing(false);
      setProgress(null);
      setError(null);
      setSelectedLang(transcriptModelConfig.asrLanguage || 'auto');

      // Fetch available models using centralized hook
      fetchModels();
    }
  }, [open, transcriptModelConfig, fetchModels, resetSelection]);

  // Listen for retranscription events
  useEffect(() => {
    if (!open) return;

    const unlisteners: UnlistenFn[] = [];
    const cleanedUpRef = { current: false };

    const setupListeners = async () => {
      // Progress events
      const unlistenProgress = await listen<RetranscriptionProgress>(
        'retranscription-progress',
        (event) => {
          if (event.payload.meeting_id === meetingId) {
            setProgress(event.payload);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenProgress();
        return;
      }
      unlisteners.push(unlistenProgress);

      // Completion event
      const unlistenComplete = await listen<RetranscriptionResult>(
        'retranscription-complete',
        async (event) => {
          if (event.payload.meeting_id === meetingId) {
            await Analytics.track('enhance_transcript_completed', {
              success: 'true',
              duration_seconds: event.payload.duration_seconds.toString(),
              segments_count: event.payload.segments_count.toString()
            });

            setIsProcessing(false);
            toast.success(
              t('retranscribe.complete', { count: event.payload.segments_count })
            );
            onCompleteRef.current?.();
            onOpenChangeRef.current(false);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenComplete();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenComplete);

      // Error event
      const unlistenError = await listen<RetranscriptionError>(
        'retranscription-error',
        async (event) => {
          if (event.payload.meeting_id === meetingId) {
            await Analytics.trackError('enhance_transcript_failed', event.payload.error);

            setIsProcessing(false);
            setError(event.payload.error);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenError();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenError);
    };

    setupListeners();

    return () => {
      cleanedUpRef.current = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [open, meetingId]);

  const handleStartRetranscription = async () => {
    if (loadingModels || !selectedModelDetails) return;
    if (!meetingFolderPath) {
      setError(t('retranscribe.folderPathUnavailable'));
      return;
    }

    setIsProcessing(true);
    setError(null);
    setProgress(null);

    try {
      const languageToSend = languageForModel === 'auto' ? null : languageForModel;
      await Analytics.track('enhance_transcript_started', {
        language: languageForModel,
        model_provider: selectedModelDetails?.provider || '',
        model_name: selectedModelDetails?.name || ''
      });

      // Backend speaker flag is process-local; push the stored preference
      // so the enhanced pass honors the diarization toggle after restarts
      await syncSpeakerEnabledToBackend();

      await invoke('start_retranscription_command', {
        meetingId,
        meetingFolderPath,
        language: languageToSend,
        model: selectedModelDetails?.name || null,
        provider: selectedModelDetails?.provider || null,
      });
    } catch (err: any) {
      setIsProcessing(false);
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err));
      setError(errorMsg);

      await Analytics.trackError('enhance_transcript_failed', errorMsg);
    }
  };

  const handleCancel = async () => {
    if (isProcessing) {
      try {
        await invoke('cancel_retranscription_command');
        setIsProcessing(false);
        setProgress(null);
        toast.info(t('retranscribe.cancelled'));
      } catch (err) {
        console.error('Failed to cancel retranscription:', err);
      }
    }
    onOpenChange(false);
  };

  // Prevent closing during processing
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isProcessing) {
      return;
    }
    onOpenChange(newOpen);
  };

  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (isProcessing) {
      event.preventDefault();
    }
  };

  const handleInteractOutside = (event: Event) => {
    if (isProcessing) {
      event.preventDefault();
    }
  };

  // The backend sends a stable stage key plus raw counters, so all the wording
  // lives here and gets translated. Keys are shared with the import dialog.
  // `message` is only a fallback for stages this switch does not know about.
  const stageLabel = (stage: string) =>
    t(`importAudio.stage.${stage}`, { defaultValue: stage });

  const stepMessage = (p: RetranscriptionProgress) => {
    switch (p.stage) {
      case 'vad':
        return p.total != null
          ? t('importAudio.step.vadFound', { count: p.total })
          : t('importAudio.step.vad');
      case 'diarizing':
        return p.current != null && p.total != null
          ? t('importAudio.step.diarizingElapsed', {
              elapsed: formatDuration(p.current),
              estimate: formatDuration(p.total),
            })
          : t('importAudio.step.diarizing');
      case 'transcribing':
        return p.current != null && p.total != null
          ? t('importAudio.step.transcribing', { current: p.current, total: p.total })
          : t('importAudio.step.loadingEngine');
      default:
        return t(`importAudio.step.${p.stage}`, { defaultValue: p.message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[450px]"
        onEscapeKeyDown={handleEscapeKeyDown}
        onInteractOutside={handleInteractOutside}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isProcessing ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                {t('retranscribe.retranscribing')}
              </>
            ) : error ? (
              <>
                <AlertCircle className="h-5 w-5 text-red-600" />
                {t('retranscribe.failed')}
              </>
            ) : (
              <>
                <RefreshCw className="h-5 w-5 text-blue-600" />
                {t('retranscribe.title')}
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {isProcessing
              ? t('retranscribe.processingAudio')
              : error
                ? t('retranscribe.errorOccurred')
                : t('retranscribe.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!isProcessing && !error && (
            <AsrLanguageSelector value={languageForModel} onValueChange={setSelectedLang}
              model={selectedModelDetails} disabled={loadingModels} />
          )}

          {!isProcessing && !error && availableModels.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{t('retranscribe.model')}</span>
              </div>
              <Select value={selectedModelKey} onValueChange={handleModelChange} disabled={loadingModels}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={loadingModels ? t('retranscribe.loadingModels') : t('retranscribe.selectModel')} />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((model) => (
                    <SelectItem key={`${model.provider}:${model.name}`} value={`${model.provider}:${model.name}`}>
                      {model.displayName} ({Math.round(model.size_mb)} MB)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('retranscribe.modelHint')}
              </p>
            </div>
          )}

          {isProcessing && progress && (
            <div className="space-y-2">
              <div className="relative">
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className="bg-blue-600 h-3 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(progress.progress_percentage, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-gray-600 mt-1">
                  <span>{stageLabel(progress.stage)}</span>
                  <span>{Math.round(progress.progress_percentage)}%</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground text-center">
                {stepMessage(progress)}
              </p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {!isProcessing && !error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleStartRetranscription}
                className="bg-blue-600 hover:bg-blue-700"
                disabled={!meetingFolderPath || loadingModels || !selectedModelDetails}
                title={!selectedModelDetails ? '请先选择可用的识别模型' : undefined}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('retranscribe.start')}
              </Button>
            </>
          )}
          {isProcessing && (
            <Button variant="outline" onClick={handleCancel}>
              <X className="h-4 w-4 mr-2" />
              {t('common.cancel')}
            </Button>
          )}
          {error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.close')}
              </Button>
              <Button
                onClick={() => {
                  setError(null);
                  setProgress(null);
                }}
                variant="outline"
              >
                {t('retranscribe.tryAgain')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
