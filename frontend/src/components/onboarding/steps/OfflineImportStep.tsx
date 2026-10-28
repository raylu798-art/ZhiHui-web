import React, { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  AlertCircle,
  Check,
  FolderOpen,
  Languages,
  Loader2,
  Mic,
  Sparkles,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

type ResourceKind = 'sensevoice' | 'parakeet' | 'whisper' | 'speaker' | 'summary';

interface ResourceFile {
  source: string;
  target: string;
  bytes: number;
}

interface OfflineResource {
  id: string;
  kind: ResourceKind;
  name: string;
  displayName: string;
  totalBytes: number;
  files: ResourceFile[];
  valid: boolean;
  invalidReason: string | null;
  alreadyInstalled: boolean;
}

interface OfflineScanResult {
  root: string;
  modelsRoot: string;
  installRoot: string;
  manifestVersion: string | null;
  declaredMissing: string[];
  resources: OfflineResource[];
}

interface OfflineImportSummary {
  imported: string[];
  skipped: string[];
  failed: string[];
  copiedBytes: number;
  elapsedSecs: number;
}

interface AppliedConfig {
  transcriptProvider: string;
  transcriptModel: string;
  summaryModel: string | null;
  speakerReady: boolean;
}

interface ImportProgress {
  currentFile: string;
  fileIndex: number;
  totalFiles: number;
  copiedBytes: number;
  totalBytes: number;
  percent: number;
  speedMbps: number;
  status: string;
}

type Phase = 'idle' | 'scanning' | 'ready' | 'importing' | 'applying' | 'done';

const KIND_ICONS: Record<ResourceKind, React.ComponentType<{ className?: string }>> = {
  sensevoice: Mic,
  parakeet: Mic,
  whisper: Languages,
  speaker: Users,
  summary: Sparkles,
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

export function OfflineImportStep() {
  const { t } = useTranslation();
  const {
    goNext,
    setInstallMode,
    setParakeetDownloaded,
    setSummaryModelDownloaded,
    setSelectedSummaryModel,
    completeOnboarding,
  } = useOnboarding();

  const [isMac, setIsMac] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [scan, setScan] = useState<OfflineScanResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const importingRef = useRef(false);

  useEffect(() => {
    const checkPlatform = async () => {
      try {
        const { platform } = await import('@tauri-apps/plugin-os');
        setIsMac(platform() === 'macos');
      } catch (e) {
        setIsMac(navigator.userAgent.includes('Mac'));
      }
    };
    checkPlatform();
  }, []);

  // Copy progress pushed by the backend while files are being written.
  useEffect(() => {
    const unlisten = listen<ImportProgress>('offline-import-progress', (event) => {
      setProgress(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const handlePickFolder = useCallback(async () => {
    setError(null);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== 'string') return;

      setPhase('scanning');
      setScan(null);
      setSelected([]);
      const result = await invoke<OfflineScanResult>('offline_scan_resources', { dir: picked });
      setScan(result);
      setSelected(
        result.resources.filter((r) => r.valid && !r.alreadyInstalled).map((r) => r.id)
      );
      setPhase('ready');
      if (result.resources.length === 0) {
        setError(t('onboarding.offline.noResources'));
      }
    } catch (e) {
      console.error('[OfflineImportStep] Scan failed:', e);
      setError(String(e));
      setPhase('idle');
    }
  }, [t]);

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleImport = async () => {
    if (!scan || importingRef.current) return;
    importingRef.current = true;
    setError(null);
    setPhase('importing');
    setProgress(null);

    try {
      const summary = await invoke<OfflineImportSummary>('offline_import_resources', {
        dir: scan.root,
        ids: selected,
      });

      if (summary.failed.length > 0) {
        setError(t('onboarding.offline.partialFailure', { n: summary.failed.length }));
        setPhase('ready');
        importingRef.current = false;
        return;
      }

      setPhase('applying');
      const applied = await invoke<AppliedConfig>('offline_apply_imported_config');

      // Mirror the imported state into the onboarding context so the rest of
      // the flow behaves exactly like the online download path.
      setParakeetDownloaded(true);
      if (applied.summaryModel) {
        setSelectedSummaryModel(applied.summaryModel);
        setSummaryModelDownloaded(true);
      }

      toast.success(t('onboarding.offline.importDone'), {
        description: t('onboarding.offline.importDoneDesc', {
          engine: applied.transcriptModel,
          summary: applied.summaryModel ?? '-',
        }),
      });
      setPhase('done');

      if (isMac) {
        goNext();
      } else {
        await completeOnboarding({
          transcriptProvider: applied.transcriptProvider,
          transcriptModel: applied.transcriptModel,
        });
        window.location.reload();
      }
    } catch (e) {
      console.error('[OfflineImportStep] Import failed:', e);
      setError(String(e));
      setPhase('ready');
    } finally {
      importingRef.current = false;
    }
  };

  const busy = phase === 'scanning' || phase === 'importing' || phase === 'applying';
  const selectedBytes = (scan?.resources ?? [])
    .filter((r) => selected.includes(r.id))
    .reduce((sum, r) => sum + r.totalBytes, 0);
  // Nothing left to copy still needs a way forward: the preseed scripts drop the
  // models straight into the app directory, so every entry shows up as already
  // installed and the import turns into a config-only step.
  const nothingToCopy = selected.length === 0;
  const canProceed =
    !!scan && (!nothingToCopy || scan.resources.some((r) => r.alreadyInstalled));

  const renderResource = (resource: OfflineResource) => {
    const Icon = KIND_ICONS[resource.kind] ?? Mic;
    const checked = selected.includes(resource.id);
    const selectable = resource.valid && !resource.alreadyInstalled && !busy;

    return (
      <button
        key={resource.id}
        type="button"
        disabled={!selectable}
        onClick={() => toggle(resource.id)}
        className={`w-full flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
          resource.valid ? 'border-gray-200 bg-white' : 'border-red-200 bg-red-50'
        } ${selectable ? 'hover:bg-gray-50' : 'cursor-default'}`}
      >
        <div
          className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
            checked ? 'bg-gray-900 border-gray-900' : 'border-gray-300'
          } ${resource.valid ? '' : 'opacity-40'}`}
        >
          {checked && <Check className="w-3 h-3 text-white" />}
        </div>

        <Icon className="w-4 h-4 mt-0.5 text-gray-500 flex-shrink-0" />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-900">{resource.displayName}</span>
            {resource.alreadyInstalled && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                {t('onboarding.offline.installed')}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">
            {formatBytes(resource.totalBytes)}
            {resource.files.length > 1 &&
              ` · ${t('onboarding.offline.fileCount', { n: resource.files.length })}`}
          </div>
          {!resource.valid && resource.invalidReason && (
            <div className="text-xs text-red-600 mt-1">{resource.invalidReason}</div>
          )}
        </div>
      </button>
    );
  };

  return (
    <OnboardingContainer
      title={t('onboarding.offline.title')}
      description={t('onboarding.offline.description')}
      step={3}
      totalSteps={isMac ? 4 : 3}
    >
      <div className="flex flex-col items-center space-y-6">
        <div className="w-full max-w-md space-y-4">
          {/* Folder picker */}
          <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-3">
            <Button
              variant="outline"
              onClick={handlePickFolder}
              disabled={busy}
              className="w-full h-11"
            >
              {phase === 'scanning' ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FolderOpen className="w-4 h-4" />
              )}
              {scan ? t('onboarding.offline.changeFolder') : t('onboarding.offline.pickFolder')}
            </Button>

            {scan && (
              <div className="text-xs text-gray-500 break-all space-y-1">
                <div>
                  {t('onboarding.offline.scannedPath')}: {scan.modelsRoot}
                </div>
                {scan.manifestVersion && (
                  <div>
                    {t('onboarding.offline.manifestVersion')}: {scan.manifestVersion}
                  </div>
                )}
              </div>
            )}

            {!scan && phase !== 'scanning' && (
              <p className="text-xs text-gray-500">{t('onboarding.offline.pickFolderHint')}</p>
            )}
          </div>

          {/* Resource list */}
          {scan && scan.resources.length > 0 && (
            <div className="space-y-2">{scan.resources.map(renderResource)}</div>
          )}

          {scan && scan.declaredMissing.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              {t('onboarding.offline.declaredMissing', { items: scan.declaredMissing.join(', ') })}
            </div>
          )}

          {/* Progress */}
          {(phase === 'importing' || phase === 'applying') && (
            <div className="rounded-lg border border-gray-200 bg-white p-4 space-y-2">
              <div className="flex items-center justify-between text-sm text-gray-700">
                <span className="truncate mr-2">
                  {phase === 'applying'
                    ? t('onboarding.offline.applying')
                    : progress?.currentFile || t('onboarding.offline.preparing')}
                </span>
                <span className="tabular-nums flex-shrink-0">
                  {Math.round(progress?.percent ?? 0)}%
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full bg-gray-900 transition-all duration-200"
                  style={{ width: `${Math.min(progress?.percent ?? 0, 100)}%` }}
                />
              </div>
              {progress && (
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>
                    {t('onboarding.offline.fileProgress', {
                      current: progress.fileIndex,
                      total: progress.totalFiles,
                    })}
                  </span>
                  <span>{progress.speedMbps.toFixed(1)} MB/s</span>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
              <span className="text-xs text-red-700 break-all">{error}</span>
            </div>
          )}
        </div>

        {/* CTA */}
        <div className="w-full max-w-xs space-y-4">
          <Button
            onClick={handleImport}
            disabled={busy || !canProceed}
            className="w-full h-11 bg-gray-900 hover:bg-gray-800 text-white"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {nothingToCopy
              ? t('onboarding.offline.continueWithInstalled')
              : t('onboarding.offline.startImportWithSize', { size: formatBytes(selectedBytes) })}
          </Button>
          <div className="text-center">
            <button
              type="button"
              disabled={busy}
              onClick={() => setInstallMode('online')}
              className="text-xs text-gray-600 hover:underline disabled:opacity-50"
            >
              {t('onboarding.offline.switchToOnline')}
            </button>
          </div>
        </div>
      </div>
    </OnboardingContainer>
  );
}
