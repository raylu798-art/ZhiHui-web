import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import Analytics from '@/lib/analytics';
import { syncSpeakerEnabledToBackend } from '@/lib/speaker';
import { applyPinnedSummaryLanguageToMeeting } from '@/lib/summary-language-preferences';
import { toast } from 'sonner';
import i18n from '@/lib/i18n/config';

export interface AudioFileInfo {
  path: string;
  filename: string;
  duration_seconds: number;
  size_bytes: number;
  format: string;
}

export interface TextFileInfo {
  path: string;
  filename: string;
  size_bytes: number;
  format: string;
  line_count: number;
}

export type ImportFileInfo = AudioFileInfo | TextFileInfo;

export function isAudioFileInfo(info: ImportFileInfo): info is AudioFileInfo {
  return 'duration_seconds' in info;
}

export interface ImportProgress {
  /** Queue task id - used to match events to the task this dialog started. */
  task_id?: string | null;
  stage: string;
  progress_percentage: number;
  /** Untranslated fallback; the dialog builds its wording from `stage`. */
  message: string;
  /** Work done inside the stage: transcribed segments, or elapsed seconds. */
  current?: number | null;
  /** Stage total: segment count, estimated seconds, or segments found by VAD. */
  total?: number | null;
}

export interface ImportResult {
  task_id?: string;
  meeting_id: string;
  title: string;
  segments_count: number;
  duration_seconds: number;
}

export interface ImportError {
  task_id?: string;
  error: string;
}

export type ImportStatus = 'idle' | 'validating' | 'processing' | 'complete' | 'error';

/** Import mode: audio transcription pipeline or text document parsing. */
export type ImportMode = 'audio' | 'text';

export interface StartImportOptions {
  language?: string | null;
  model?: string | null;
  provider?: string | null;
  autoSpeaker?: boolean;
  autoSummary?: boolean;
}

export interface UseImportAudioOptions {
  mode?: ImportMode;
  onComplete?: (result: ImportResult) => void;
  onError?: (error: string) => void;
}

export interface UseImportAudioReturn {
  status: ImportStatus;
  fileInfo: ImportFileInfo | null;
  progress: ImportProgress | null;
  error: string | null;
  isProcessing: boolean;
  isBusy: boolean;
  /** Id of the queue task started by this hook instance (if any). */
  activeTaskId: string | null;
  selectFile: () => Promise<ImportFileInfo | null>;
  validateFile: (path: string) => Promise<ImportFileInfo | null>;
  startImport: (sourcePath: string, title: string, options?: StartImportOptions) => Promise<void>;
  cancelImport: () => Promise<void>;
  reset: () => void;
}

export function useImportAudio({
  mode = 'audio',
  onComplete,
  onError,
}: UseImportAudioOptions = {}): UseImportAudioReturn {
  const [status, setStatus] = useState<ImportStatus>('idle');
  const [fileInfo, setFileInfo] = useState<ImportFileInfo | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  // Stable refs for callbacks to avoid listener re-registration on every render
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // Task this hook instance is tracking; events for other tasks are ignored
  // (they belong to other dialogs or queue runs).
  const activeTaskIdRef = useRef<string | null>(null);

  // Cancellation guard: prevents late events from updating state after cancel
  const isCancelledRef = useRef(false);

  const matchesActiveTask = (taskId?: string | null): boolean => {
    const active = activeTaskIdRef.current;
    if (!active) return false;
    return taskId === active;
  };

  // Set up event listeners (registered once, use refs for callbacks)
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    const cleanedUpRef = { current: false };

    const setupListeners = async () => {
      // Progress events
      const unlistenProgress = await listen<ImportProgress>(
        'import-progress',
        (event) => {
          if (isCancelledRef.current) return;
          if (!matchesActiveTask(event.payload.task_id)) return;
          setProgress(event.payload);
          setStatus('processing');
        }
      );
      if (cleanedUpRef.current) {
        unlistenProgress();
        return;
      }
      unlisteners.push(unlistenProgress);

      // Completion event
      const unlistenComplete = await listen<ImportResult>(
        'import-complete',
        async (event) => {
          if (isCancelledRef.current) return;
          if (!matchesActiveTask(event.payload.task_id)) return;

          await Analytics.track('import_completed', {
            success: 'true',
            duration_seconds: event.payload.duration_seconds.toString(),
            segments_count: event.payload.segments_count.toString()
          });

          activeTaskIdRef.current = null;
          setActiveTaskId(null);
          setStatus('complete');
          setProgress(null);
          try {
            await applyPinnedSummaryLanguageToMeeting(event.payload.meeting_id);
          } catch (error) {
            console.warn('Failed to apply pinned summary language to imported meeting:', error);
            toast.warning(i18n.t('toasts.summaryLangNotApplied'), {
              description: i18n.t('toasts.importedLangNotAppliedDesc'),
            });
          }
          onCompleteRef.current?.(event.payload);
        }
      );
      if (cleanedUpRef.current) {
        unlistenComplete();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenComplete);

      // Error event
      const unlistenError = await listen<ImportError>(
        'import-error',
        async (event) => {
          if (isCancelledRef.current) return;
          if (!matchesActiveTask(event.payload.task_id)) return;

          await Analytics.trackError('import_failed', event.payload.error);

          activeTaskIdRef.current = null;
          setActiveTaskId(null);
          setStatus('error');
          setError(event.payload.error);
          onErrorRef.current?.(event.payload.error);
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
  }, []);

  // Select file using native file dialog (mode-aware)
  const selectFile = useCallback(async (): Promise<ImportFileInfo | null> => {
    setStatus('validating');
    setError(null);

    try {
      const command = mode === 'text' ? 'select_and_validate_text_command' : 'select_and_validate_audio_command';
      const result = await invoke<ImportFileInfo | null>(command);
      if (result) {
        setFileInfo(result);
        setStatus('idle');
        return result;
      } else {
        // User cancelled
        setStatus('idle');
        return null;
      }
    } catch (err: any) {
      setStatus('error');
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err) || 'Failed to validate file');
      setError(errorMsg);
      onErrorRef.current?.(errorMsg);
      return null;
    }
  }, [mode]);

  // Validate a file from a given path (for drag-drop)
  const validateFile = useCallback(async (path: string): Promise<ImportFileInfo | null> => {
    setStatus('validating');
    setError(null);

    try {
      const command = mode === 'text' ? 'validate_text_file_command' : 'validate_audio_file_command';
      const result = await invoke<ImportFileInfo>(command, { path });
      setFileInfo(result);
      setStatus('idle');
      return result;
    } catch (err: any) {
      setStatus('error');
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err) || 'Failed to validate file');
      setError(errorMsg);
      onErrorRef.current?.(errorMsg);
      return null;
    }
  }, [mode]);

  // Start the import process (enqueues into the background import queue)
  const startImport = useCallback(
    async (sourcePath: string, title: string, options: StartImportOptions = {}) => {
      isCancelledRef.current = false;
      setStatus('processing');
      setError(null);
      setProgress(null);

      try {
        if (fileInfo) {
          await Analytics.track(mode === 'text' ? 'import_text_started' : 'import_audio_started', {
            file_size_bytes: fileInfo.size_bytes.toString(),
            format: fileInfo.format,
          });
        }

        let response: { task_id: string };
        if (mode === 'text') {
          response = await invoke('start_import_text_command', {
            sourcePath,
            title,
            autoSpeaker: options.autoSpeaker ?? false,
            autoSummary: options.autoSummary ?? false,
          });
        } else {
          // Backend speaker flag is process-local; push the stored preference
          // so imported audio honors the diarization toggle after restarts
          await syncSpeakerEnabledToBackend();

          response = await invoke('start_import_audio_command', {
            sourcePath,
            title,
            language: options.language || null,
            model: options.model || null,
            provider: options.provider || null,
            autoSummary: options.autoSummary ?? false,
          });
        }

        activeTaskIdRef.current = response.task_id;
        setActiveTaskId(response.task_id);
      } catch (err: any) {
        setStatus('error');
        const errorMsg = typeof err === 'string' ? err : (err?.message || String(err) || 'Failed to start import');
        setError(errorMsg);

        await Analytics.trackError('import_failed', errorMsg);

        onErrorRef.current?.(errorMsg);
      }
    },
    [fileInfo, mode]
  );

  // Cancel ongoing import (running task + queued tasks)
  const cancelImport = useCallback(async () => {
    isCancelledRef.current = true;
    activeTaskIdRef.current = null;
    setActiveTaskId(null);
    try {
      await invoke('cancel_import_command');
      setStatus('idle');
      setProgress(null);
    } catch (err: any) {
      console.error('Failed to cancel import:', err);
    }
  }, []);

  // Reset all state
  const reset = useCallback(() => {
    isCancelledRef.current = false;
    activeTaskIdRef.current = null;
    setActiveTaskId(null);
    setStatus('idle');
    setFileInfo(null);
    setProgress(null);
    setError(null);
  }, []);

  return {
    status,
    fileInfo,
    progress,
    error,
    isProcessing: status === 'processing',
    isBusy: status === 'processing' || status === 'validating',
    activeTaskId,
    selectFile,
    validateFile,
    startImport,
    cancelImport,
    reset,
  };
}
