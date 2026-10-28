"use client";
import { useState, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { motion } from 'framer-motion';
import { Summary, SummaryResponse } from '@/types';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TranscriptPanel } from '@/components/MeetingDetails/TranscriptPanel';
import { SummaryPanel } from '@/components/MeetingDetails/SummaryPanel';
import { ModelConfig } from '@/components/ModelSettingsModal';

// Custom hooks
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { useConfig } from '@/contexts/ConfigContext';
import { useTranslation } from 'react-i18next';

export default function PageContent({
  meeting,
  summaryData,
  shouldAutoGenerate = false,
  onAutoGenerateComplete,
  onMeetingUpdated,
  onRefetchTranscripts,
  // Pagination props for efficient transcript loading
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  // Transcript version switcher (live vs enhanced)
  transcriptSource,
  availableTranscriptSources,
  onTranscriptSourceChange,
  // Inline transcript editing
  onEditSegment,
  onRenameSpeaker,
}: {
  meeting: any;
  summaryData: Summary | null;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  // Pagination props
  segments?: any[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
  transcriptSource?: string | null;
  availableTranscriptSources?: string[];
  onTranscriptSourceChange?: (source: string) => void;
  onEditSegment?: (id: string, text: string, speaker?: string) => Promise<void>;
  onRenameSpeaker?: (oldSpeaker: string, newSpeaker: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  console.log('📄 PAGE CONTENT: Initializing with data:', {
    meetingId: meeting.id,
    summaryDataKeys: summaryData ? Object.keys(summaryData) : null,
    transcriptsCount: meeting.transcripts?.length
  });

  // State
  // Custom context input was removed from the transcript panel; keep an empty
  // prompt so the summary generation chain stays unchanged.
  const [customPrompt] = useState<string>('');
  const [isRecording] = useState(false);
  const [summaryResponse] = useState<SummaryResponse | null>(null);

  // Resizable split between the transcript (middle) and summary (right) panels
  const [transcriptWidth, setTranscriptWidth] = useState<number | undefined>(() => {
    if (typeof window === 'undefined') return undefined;
    const saved = Number(window.localStorage.getItem('zhihui-transcript-panel-width'));
    return Number.isFinite(saved) && saved >= 280 ? saved : undefined;
  });
  const [isSplitResizing, setIsSplitResizing] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  const startTranscriptResize = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setIsSplitResizing(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    const onMove = (ev: MouseEvent) => {
      const min = 280;
      const max = Math.max(min + 80, rect.width - 320);
      const width = Math.min(max, Math.max(min, Math.round(ev.clientX - rect.left)));
      setTranscriptWidth(width);
      window.localStorage.setItem('zhihui-transcript-panel-width', String(width));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setIsSplitResizing(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Ref to store the modal open function from SummaryGeneratorButtonGroup
  const openModelSettingsRef = useRef<(() => void) | null>(null);

  // Sidebar context
  const { serverAddress } = useSidebar();

  // Get model config from ConfigContext
  const { modelConfig, setModelConfig } = useConfig();

  // Custom hooks
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const templates = useTemplates();

  // Plain-text documents (no audio timestamps) auto-default to the general
  // document template until the user explicitly picks one.
  useEffect(() => {
    if (meetingData.transcripts.length > 0) {
      const isTextDocument = meetingData.transcripts.every(
        (t: { audio_start_time?: number | null }) => t.audio_start_time == null
      );
      templates.applyDocumentDefault(isTextDocument);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingData.transcripts]);

  // Re-attach to a summary generation that is still running in the backend
  // (background-queue behavior: navigating away no longer interrupts it).
  useEffect(() => {
    summaryGeneration.resumeIfProcessing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id]);

  // Callback to register the modal open function
  const handleRegisterModalOpen = (openFn: () => void) => {
    console.log('📝 Registering modal open function in PageContent');
    openModelSettingsRef.current = openFn;
  };

  // Callback to trigger modal open (called from error handler)
  const handleOpenModelSettings = () => {
    console.log('🔔 Opening model settings from PageContent');
    if (openModelSettingsRef.current) {
      openModelSettingsRef.current();
    } else {
      console.warn('⚠️ Modal open function not yet registered');
    }
  };

  // Save model config to backend database and sync via event
  const handleSaveModelConfig = async (config?: ModelConfig) => {
    if (!config) return;
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey ?? null,
        ollamaEndpoint: config.ollamaEndpoint ?? null,
      });

      // Emit event so ConfigContext and other listeners stay in sync
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);

      toast.success(t('meetingDetails.modelSaved'));
    } catch (error) {
      console.error('Failed to save model config:', error);
      toast.error(t('meetingDetails.modelSaveFailed'));
    }
  };

  const summaryGeneration = useSummaryGeneration({
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig: modelConfig,
    isModelConfigLoading: false, // ConfigContext loads on mount
    selectedTemplate: templates.selectedTemplate,
    onMeetingUpdated,
    setAiSummary: meetingData.setAiSummary,
    onOpenModelSettings: handleOpenModelSettings,
  });

  const copyOperations = useCopyOperations({
    meeting,
    transcripts: meetingData.transcripts,
    meetingTitle: meetingData.meetingTitle,
    aiSummary: meetingData.aiSummary,
    blockNoteSummaryRef: meetingData.blockNoteSummaryRef,
  });

  const meetingOperations = useMeetingOperations({
    meeting,
  });

  // Track page view
  useEffect(() => {
    Analytics.trackPageView('meeting_details');
  }, []);

  // Auto-generate summary when flag is set
  useEffect(() => {
    let cancelled = false;

    const autoGenerate = async () => {
      if (shouldAutoGenerate && meetingData.transcripts.length > 0 && !cancelled) {
        console.log(`🤖 Auto-generating summary with ${modelConfig.provider}/${modelConfig.model}...`);
        await summaryGeneration.handleGenerateSummary('');

        // Notify parent that auto-generation is complete (only if not cancelled)
        if (onAutoGenerateComplete && !cancelled) {
          onAutoGenerateComplete();
        }
      }
    };

    autoGenerate();

    // Cleanup: cancel if component unmounts or meeting changes
    return () => {
      cancelled = true;
    };
  }, [shouldAutoGenerate, meeting.id]); // Re-run if meeting changes

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col h-screen bg-gray-50"
    >
      <div ref={splitContainerRef} className="flex flex-1 overflow-hidden">
        <TranscriptPanel
          style={transcriptWidth ? { width: transcriptWidth, maxWidth: '70%' } : undefined}
          transcripts={meetingData.transcripts}
          onCopyTranscript={copyOperations.handleCopyTranscript}
          onOpenMeetingFolder={meetingOperations.handleOpenMeetingFolder}
          isRecording={isRecording}
          disableAutoScroll={true}
          // Pagination props for efficient loading
          usePagination={true}
          segments={segments}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          // Retranscription props
          meetingId={meeting.id}
          meetingFolderPath={meeting.folder_path}
          onRefetchTranscripts={onRefetchTranscripts}
          // Transcript version switcher (live vs enhanced)
          transcriptSource={transcriptSource}
          availableTranscriptSources={availableTranscriptSources}
          onTranscriptSourceChange={onTranscriptSourceChange}
          // Inline transcript editing
          onEditSegment={onEditSegment}
          onRenameSpeaker={onRenameSpeaker}
        />
        {/* Drag handle between transcript and summary panels */}
        <div
          className={`w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-blue-400 ${isSplitResizing ? 'bg-blue-400' : ''}`}
          onMouseDown={startTranscriptResize}
        />
        <SummaryPanel
          meeting={meeting}
          meetingTitle={meetingData.meetingTitle}
          onTitleChange={meetingData.handleTitleChange}
          isEditingTitle={meetingData.isEditingTitle}
          onStartEditTitle={() => meetingData.setIsEditingTitle(true)}
          onFinishEditTitle={() => meetingData.setIsEditingTitle(false)}
          isTitleDirty={meetingData.isTitleDirty}
          summaryRef={meetingData.blockNoteSummaryRef}
          transcriptSource={transcriptSource}
          isSaving={meetingData.isSaving}
          onSaveAll={meetingData.saveAllChanges}
          onCopySummary={copyOperations.handleCopySummary}
          onOpenFolder={meetingOperations.handleOpenMeetingFolder}
          aiSummary={meetingData.aiSummary}
          summaryStatus={summaryGeneration.summaryStatus}
          transcripts={meetingData.transcripts}
          modelConfig={modelConfig}
          setModelConfig={setModelConfig}
          onSaveModelConfig={handleSaveModelConfig}
          onGenerateSummary={summaryGeneration.handleGenerateSummary}
          onStopGeneration={summaryGeneration.handleStopGeneration}
          customPrompt={customPrompt}
          summaryResponse={summaryResponse}
          onSaveSummary={meetingData.handleSaveSummary}
          onSummaryChange={meetingData.handleSummaryChange}
          onDirtyChange={meetingData.setIsSummaryDirty}
          summaryError={summaryGeneration.summaryError}
          onRegenerateSummary={summaryGeneration.handleRegenerateSummary}
          getSummaryStatusMessage={summaryGeneration.getSummaryStatusMessage}
          availableTemplates={templates.availableTemplates}
          onTemplatesChanged={templates.refreshTemplates}
          selectedTemplate={templates.selectedTemplate}
          onTemplateSelect={templates.handleTemplateSelection}
          isModelConfigLoading={false}
          onOpenModelSettings={handleRegisterModalOpen}
        />
      </div>
    </motion.div>
  );
}
