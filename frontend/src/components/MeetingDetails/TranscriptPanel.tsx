"use client";

import { Transcript, TranscriptSegmentData } from '@/types';
import { TranscriptView } from '@/components/TranscriptView';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { useMemo, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Retranscription props
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;

  // Transcript version switcher (live vs enhanced)
  transcriptSource?: string | null;
  availableTranscriptSources?: string[];
  onTranscriptSourceChange?: (source: string) => void;

  // Inline transcript editing
  onEditSegment?: (id: string, text: string, speaker?: string) => Promise<void>;
  onRenameSpeaker?: (oldSpeaker: string, newSpeaker: string) => Promise<void>;

  // Optional inline style (used by the resizable split in meeting details)
  style?: CSSProperties;
}

export function TranscriptPanel({
  transcripts,
  onCopyTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
  transcriptSource,
  availableTranscriptSources,
  onTranscriptSourceChange,
  onEditSegment,
  onRenameSpeaker,
  style,
}: TranscriptPanelProps) {
  const { t } = useTranslation();
  // Convert transcripts to segments if pagination is not used but we want virtualization
  const convertedSegments = useMemo(() => {
    if (usePagination && segments) {
      return segments;
    }
    // Convert transcripts to segments for virtualization
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? null,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
      speaker: t.speaker,
    }));
  }, [transcripts, usePagination, segments]);

  return (
    <div
      className="hidden md:flex md:w-1/4 lg:w-1/3 min-w-0 border-r border-gray-200 bg-white flex-col relative shrink-0"
      style={style}
    >
      {/* Title area */}
      <div className="p-4 border-b border-gray-200">
        <TranscriptButtonGroup
          transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
          onCopyTranscript={onCopyTranscript}
          onOpenMeetingFolder={onOpenMeetingFolder}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onRefetchTranscripts={onRefetchTranscripts}
        />
        {/* Version switcher: only shown when both live and enhanced exist */}
        {availableTranscriptSources && availableTranscriptSources.length > 1 && onTranscriptSourceChange && (
          <div className="mt-2 inline-flex rounded-md border border-gray-200 bg-gray-50 p-0.5">
            {['live', 'enhanced']
              .filter((s) => availableTranscriptSources.includes(s))
              .map((s) => (
                <button
                  key={s}
                  onClick={() => onTranscriptSourceChange(s)}
                  className={`px-2.5 py-0.5 text-xs rounded transition-colors ${
                    transcriptSource === s
                      ? 'bg-white text-blue-600 shadow-sm font-medium'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {t(`transcriptVersion.${s}`)}
                </button>
              ))}
          </div>
        )}
      </div>

      {/* Transcript content - use virtualized view for better performance */}
      <div className="flex-1 overflow-hidden pb-4">
        <VirtualizedTranscriptView
          segments={convertedSegments}
          isRecording={isRecording}
          isPaused={false}
          isProcessing={false}
          isStopping={false}
          enableStreaming={false}
          disableAutoScroll={disableAutoScroll}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          editable={!isRecording}
          onEditSegment={onEditSegment}
          onRenameSpeaker={onRenameSpeaker}
        />
      </div>
    </div>
  );
}
