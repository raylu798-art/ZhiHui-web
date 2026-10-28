'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { Users, Download, Trash2, X } from 'lucide-react';
import { Button } from './ui/button';
import { Progress } from './ui/progress';
import {
  SpeakerAPI,
  SpeakerModelInfo,
  getClusterMergePreference,
} from '@/lib/speaker';

interface DownloadProgressPayload {
  progress?: number;
  status?: string;
}

interface DownloadErrorPayload {
  error?: string;
}

/**
 * Speaker diarization settings card: core capability (always on, no user
 * toggle) + ERes2Net v2 model download management. Labels (S1, S2, ...) apply
 * to live transcripts of any transcription provider.
 */
export function SpeakerSettings() {
  const { t } = useTranslation();
  const [modelInfo, setModelInfo] = useState<SpeakerModelInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const info = await SpeakerAPI.getModelInfo();
      setModelInfo(info);
      setDownloading(info.downloading);
      setProgress(info.progress);
    } catch (err) {
      console.error('Failed to fetch speaker model info:', err);
    }
  }, []);

  // Push the enforced preferences to the backend on mount: diarization is a
  // core capability (always on); cluster merge is managed in Beta settings.
  useEffect(() => {
    SpeakerAPI.setEnabled(true).catch(() => {});
    SpeakerAPI.setClusterMerge(getClusterMergePreference()).catch(() => {});
    refresh();
  }, [refresh]);

  // Download lifecycle events from the backend
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const setup = async () => {
      const progressUnlisten = await listen<DownloadProgressPayload>(
        'speaker-model-download-progress',
        (event) => {
          if (event.payload.status === 'cancelled') {
            setDownloading(false);
            setProgress(0);
            return;
          }
          setDownloading(true);
          setProgress(event.payload.progress ?? 0);
        }
      );
      const completeUnlisten = await listen('speaker-model-download-complete', () => {
        setDownloading(false);
        setProgress(100);
        toast.success(t('speakerSettings.downloadComplete'));
        refresh();
      });
      const errorUnlisten = await listen<DownloadErrorPayload>(
        'speaker-model-download-error',
        (event) => {
          setDownloading(false);
          toast.error(t('speakerSettings.downloadFailed'), {
            description: event.payload.error,
          });
          refresh();
        }
      );
      if (disposed) {
        progressUnlisten();
        completeUnlisten();
        errorUnlisten();
        return;
      }
      unlisteners.push(progressUnlisten, completeUnlisten, errorUnlisten);
    };

    setup();
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [refresh, t]);

  const handleDownload = async () => {
    setDownloading(true);
    setProgress(0);
    try {
      await SpeakerAPI.downloadModel();
    } catch (err) {
      // Failure details arrive via the download-error event
      console.error('Speaker model download failed:', err);
      setDownloading(false);
    }
    refresh();
  };

  const handleCancel = async () => {
    try {
      await SpeakerAPI.cancelDownload();
    } catch (err) {
      console.error('Failed to cancel speaker model download:', err);
    }
    setDownloading(false);
    setProgress(0);
    refresh();
  };

  const handleDelete = async () => {
    try {
      await SpeakerAPI.deleteModel();
      refresh();
    } catch (err) {
      toast.error(t('speakerSettings.deleteFailed'), { description: String(err) });
    }
  };

  return (
    <div className="mt-6 border border-gray-200 rounded-lg p-4 mx-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-gray-600" />
          <span className="text-sm font-medium text-gray-800">
            {t('speakerSettings.title')}
          </span>
        </div>
        <span className="px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 rounded-full">
          {t('speakerSettings.coreCapability')}
        </span>
      </div>
      <p className="text-xs text-gray-500 mt-1">
        {t('speakerSettings.description')}
      </p>

      <div className="mt-3">
        {downloading ? (
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <Progress value={progress} />
            </div>
            <span className="text-xs text-gray-500 min-w-[70px]">
              {t('speakerSettings.downloading', { progress })}
            </span>
            <Button variant="ghost" size="icon" onClick={handleCancel} title={t('speakerSettings.cancel')}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : modelInfo?.available ? (
          <div className="flex items-center justify-between">
            <span className="text-xs text-green-600">
              ✓ {t('speakerSettings.modelReady', { size: modelInfo.size_mb })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="text-gray-500 hover:text-red-600"
              onClick={handleDelete}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              {t('speakerSettings.delete')}
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">
              {t('speakerSettings.modelMissing')}
            </span>
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download className="h-3.5 w-3.5 mr-1" />
              {t('speakerSettings.download')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
