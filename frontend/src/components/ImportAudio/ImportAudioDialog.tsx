import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Upload,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  Cpu,
  FileAudio,
  FileText,
  Clock,
  HardDrive,
  AlignLeft,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { AsrLanguageSelector } from '@/components/AsrLanguageSelector';
import { normalizeAsrLanguage } from '@/lib/asr-languages';
import {
  useImportAudio,
  ImportResult,
  ImportProgress,
  isAudioFileInfo,
} from '@/hooks/useImportAudio';
import { useRouter } from 'next/navigation';
import { useSidebar } from '../Sidebar/SidebarProvider';
import { useTranscriptionModels, ModelOption } from '@/hooks/useTranscriptionModels';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { localizeBackendError } from '@/lib/errorMessages';
import { useLicense } from '@/contexts/LicenseContext';


interface ImportAudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedFile?: string | null;
  onComplete?: () => void;
}

type ImportTab = 'audio' | 'text';

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function ImportAudioDialog({
  open,
  onOpenChange,
  preselectedFile,
  onComplete,
}: ImportAudioDialogProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const { refetchMeetings } = useSidebar();
  const { transcriptModelConfig } = useConfig();
  const { isFeatureAllowed } = useLicense();
  const licenseAllowed = isFeatureAllowed();

  const [activeTab, setActiveTab] = useState<ImportTab>('audio');
  const [title, setTitle] = useState('');
  const [selectedLang, setSelectedLang] = useState(transcriptModelConfig.asrLanguage || 'auto');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [titleModifiedByUser, setTitleModifiedByUser] = useState(false);

  // Always start as false — represents "dialog has not yet been opened".
  // Do NOT initialize from the `open` prop: if the component mounts with open=true
  // (e.g. drag-drop path), we still need the initialization effect to run.
  const prevOpenRef = useRef(false);
  // Track dialog visibility for completion handling (queue can finish after close)
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  // Use centralized model fetching hook
  const {
    availableModels,
    selectedModelKey,
    setSelectedModelKey,
    loadingModels,
    fetchModels,
    resetSelection,
  } = useTranscriptionModels(transcriptModelConfig);

  const handleImportComplete = useCallback((result: ImportResult) => {
    toast.success(t('importAudio.importCompleteToast', { count: result.segments_count }));

    // Refresh meetings list; only navigate if the dialog is still open
    // (queued imports can complete after the user closed the dialog)
    refetchMeetings();
    onComplete?.();
    if (openRef.current) {
      onOpenChange(false);
      router.push(`/meeting-details?id=${result.meeting_id}`);
    }
  }, [router, refetchMeetings, onComplete, onOpenChange, t]);

  const handleImportError = useCallback((error: string) => {
    if (openRef.current) {
      toast.error(t('importAudio.importFailedToast'), { description: localizeBackendError(error, t) });
    }
  }, [t]);

  // One hook instance per mode; each tracks its own queue task via task_id
  const audioImport = useImportAudio({
    mode: 'audio',
    onComplete: handleImportComplete,
    onError: handleImportError,
  });
  const textImport = useImportAudio({
    mode: 'text',
    onComplete: handleImportComplete,
    onError: handleImportError,
  });

  const imp = activeTab === 'audio' ? audioImport : textImport;
  const {
    status,
    fileInfo,
    progress,
    error,
    isProcessing,
    selectFile,
    validateFile,
    startImport,
    cancelImport,
    reset,
  } = imp;

  // Reset state only when dialog transitions from closed to open
  // This prevents re-initialization when config changes while dialog is already open (Bug #4 & #5)
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    // Only initialize when transitioning from closed (false) to open (true)
    if (open && !wasOpen) {
      audioImport.reset();
      textImport.reset();
      resetSelection();
      setActiveTab('audio');
      setTitle('');
      setTitleModifiedByUser(false);
      setSelectedLang(transcriptModelConfig.asrLanguage || 'auto');
      setShowAdvanced(false);

      // Validate preselected file if provided
      if (preselectedFile) {
        audioImport.validateFile(preselectedFile).then((info) => {
          if (info) {
            setTitle(info.filename);
          }
        });
      }

      // Fetch available models using centralized hook
      fetchModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preselectedFile, transcriptModelConfig]);

  // Update title when fileInfo changes
  useEffect(() => {
    if (fileInfo && !title && !titleModifiedByUser) {
      setTitle(fileInfo.filename);
    }
  }, [fileInfo, title, titleModifiedByUser]);

  const handleTabChange = (tab: ImportTab) => {
    if (tab === activeTab || isProcessing) return;
    setActiveTab(tab);
  };

  const selectedModel = useMemo((): ModelOption | undefined => {
    if (!selectedModelKey) return undefined;
    const colonIndex = selectedModelKey.indexOf(':');
    if (colonIndex === -1) return undefined;
    const provider = selectedModelKey.slice(0, colonIndex);
    const name = selectedModelKey.slice(colonIndex + 1);
    return availableModels.find((m) => m.provider === provider && m.name === name);
  }, [selectedModelKey, availableModels]);
  const languageForModel = normalizeAsrLanguage(selectedLang, selectedModel);

  const handleModelChange = (key: string) => {
    const model = availableModels.find((item) => `${item.provider}:${item.name}` === key);
    setSelectedLang(normalizeAsrLanguage(selectedLang, model));
    setSelectedModelKey(key);
  };

  const handleSelectFile = async () => {
    const info = await selectFile();
    if (info) {
      setTitle(info.filename);
      setTitleModifiedByUser(false);
    }
  };

  const handleStartImport = async () => {
    if (!fileInfo) return;
    if (activeTab === 'audio' && (loadingModels || !selectedModel)) return;

    if (activeTab === 'text') {
      // Text import keeps the document as-is; summary is generated later
      // from the meeting details page with a user-selected template.
      await startImport(fileInfo.path, title || fileInfo.filename, {
        autoSpeaker: false,
        autoSummary: false,
      });
    } else {
      await startImport(fileInfo.path, title || fileInfo.filename, {
        language: languageForModel === 'auto' ? null : languageForModel,
        model: selectedModel?.name || null,
        provider: selectedModel?.provider || null,
        autoSummary: false,
      });
    }
  };

  const handleCancel = async () => {
    if (isProcessing) {
      await cancelImport();
      toast.info(t('importAudio.importCancelledToast'));
    }
    onOpenChange(false);
  };

  // Queue mode: the dialog can be closed while a task is processing —
  // the task keeps running in the background queue.
  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen);
  };

  // The backend sends a stable stage key plus raw counters, so all the wording
  // lives here and gets translated. `message` is only a fallback for stages
  // this switch does not know about.
  const stageLabel = (stage: string) =>
    t(`importAudio.stage.${stage}`, { defaultValue: stage });

  const stepMessage = (p: ImportProgress) => {
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

  const isAudioFile = fileInfo ? isAudioFileInfo(fileInfo) : activeTab === 'audio';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isProcessing ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                {t('importAudio.importingTitle')}
              </>
            ) : error ? (
              <>
                <AlertCircle className="h-5 w-5 text-red-600" />
                {t('importAudio.importFailedTitle')}
              </>
            ) : status === 'complete' ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                {t('importAudio.importCompleteTitle')}
              </>
            ) : (
              <>
                <Upload className="h-5 w-5 text-blue-600" />
                {t('importAudio.title')}
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {isProcessing
              ? t('importAudio.processingAudio')
              : error
              ? t('importAudio.errorDuringImport')
              : t('importAudio.description')}
          </DialogDescription>
        </DialogHeader>

        {/* Import type tabs */}
        {!isProcessing && !error && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            <button
              onClick={() => handleTabChange('audio')}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium transition-colors',
                activeTab === 'audio'
                  ? 'bg-gray-900 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              )}
            >
              <FileAudio className="h-4 w-4" />
              音频文件
            </button>
            <button
              onClick={() => handleTabChange('text')}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium transition-colors',
                activeTab === 'text'
                  ? 'bg-gray-900 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              )}
            >
              <FileText className="h-4 w-4" />
              文本文件
            </button>
          </div>
        )}

        <div className="space-y-4 py-4">
          {/* File selection / info */}
          {!isProcessing && !error && (
            <>
              {fileInfo ? (
                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    {isAudioFile ? (
                      <FileAudio className="h-8 w-8 text-blue-600 flex-shrink-0" />
                    ) : (
                      <FileText className="h-8 w-8 text-blue-600 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 break-all">{fileInfo.filename}</p>
                      <div className="flex items-center gap-4 text-sm text-gray-500 mt-1">
                        {isAudioFileInfo(fileInfo) ? (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3.5 w-3.5" />
                            {formatDuration(fileInfo.duration_seconds)}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1">
                            <AlignLeft className="h-3.5 w-3.5" />
                            {fileInfo.line_count} 行
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <HardDrive className="h-3.5 w-3.5" />
                          {formatFileSize(fileInfo.size_bytes)}
                        </span>
                        <span className="text-blue-600 font-medium">{fileInfo.format}</span>
                      </div>
                    </div>
                  </div>

                  {/* Editable title */}
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-700">{t('importAudio.meetingTitle')}</label>
                    <Input
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        setTitleModifiedByUser(true);
                      }}
                      placeholder={t('importAudio.enterMeetingTitle')}
                    />
                  </div>

                  <Button variant="outline" size="sm" onClick={handleSelectFile} className="w-full">
                    {t('importAudio.chooseDifferentFile')}
                  </Button>
                </div>
              ) : (
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                  {activeTab === 'audio' ? (
                    <FileAudio className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  ) : (
                    <FileText className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  )}
                  <Button onClick={handleSelectFile} disabled={status === 'validating'}>
                    {status === 'validating' ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {t('importAudio.validating')}
                      </>
                    ) : activeTab === 'audio' ? (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        {t('importAudio.selectAudioFile')}
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        选择文本文件
                      </>
                    )}
                  </Button>
                  <p className="text-sm text-gray-500 mt-2">
                    {activeTab === 'audio'
                      ? t('importAudio.formatsHint')
                      : '支持 TXT、Markdown、Word (.docx)、PDF (.pdf)'}
                  </p>
                </div>
              )}

              {/* Post-import hint: summary is generated from the details page */}
              {fileInfo && (
                <p className="text-xs text-gray-500 px-1">
                  {activeTab === 'text'
                    ? '导入将保持文件原有段落结构；导入完成后可在会议详情页选择摘要模板生成摘要'
                    : '导入完成后可在会议详情页选择摘要模板生成摘要'}
                </p>
              )}

              {/* Advanced options (audio tab only, collapsible) */}
              {activeTab === 'audio' && fileInfo && (
                <div className="border rounded-lg">
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="w-full flex items-center justify-between p-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <span>{t('importAudio.advancedOptions')}</span>
                    {showAdvanced ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </button>

                  {showAdvanced && (
                    <div className="p-3 pt-0 space-y-4 border-t">
                      <AsrLanguageSelector value={languageForModel} onValueChange={setSelectedLang}
                        model={selectedModel} disabled={loadingModels || isProcessing} />

                      {/* Model selector */}
                      {availableModels.length > 0 && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Cpu className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">{t('importAudio.model')}</span>
                          </div>
                          <Select
                            value={selectedModelKey}
                            onValueChange={handleModelChange}
                            disabled={loadingModels}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder={loadingModels ? t('importAudio.loadingModels') : t('importAudio.selectModel')} />
                            </SelectTrigger>
                            <SelectContent>
                              {availableModels.map((model) => (
                                <SelectItem
                                  key={`${model.provider}:${model.name}`}
                                  value={`${model.provider}:${model.name}`}
                                >
                                  {model.displayName} ({Math.round(model.size_mb)} MB)
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Progress display */}
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
              <p className="text-sm text-muted-foreground text-center">{stepMessage(progress)}</p>
            </div>
          )}

          {/* Processing without progress yet (queued) */}
          {isProcessing && !progress && (
            <div className="space-y-2 text-center py-4">
              <Loader2 className="h-6 w-6 animate-spin text-blue-600 mx-auto" />
              <p className="text-sm text-muted-foreground">任务已加入导入队列，等待处理...</p>
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-800">{localizeBackendError(error, t)}</p>
            </div>
          )}

          {/* License expired hint */}
          {!licenseAllowed && !isProcessing && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-800">授权已到期，请在设置—软件授权中激活 License 后再导入</p>
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
                onClick={handleStartImport}
                className="bg-blue-600 hover:bg-blue-700"
                disabled={!fileInfo || !licenseAllowed || (activeTab === 'audio' && (loadingModels || !selectedModel))}
                title={!licenseAllowed ? '授权已到期，无法导入' : activeTab === 'audio' && !selectedModel ? '请先选择可用的识别模型' : undefined}
              >
                <Upload className="h-4 w-4 mr-2" />
                {t('common.import')}
              </Button>
            </>
          )}
          {isProcessing && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                最小化到后台
              </Button>
              <Button variant="outline" onClick={handleCancel}>
                <X className="h-4 w-4 mr-2" />
                {t('common.cancel')}
              </Button>
            </>
          )}
          {error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.close')}
              </Button>
              <Button onClick={reset} variant="outline">
                {t('common.retry')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
