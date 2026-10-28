'use client';

import { useCallback, useRef, useReducer, startTransition, useEffect, useState, memo } from "react";
import { useTranslation } from "react-i18next";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAutoScroll } from "@/hooks/useAutoScroll";
import { useTranscriptStreaming } from "@/hooks/useTranscriptStreaming";
import { RecordingStatusBar } from "./RecordingStatusBar";
import { motion, AnimatePresence } from "framer-motion";
import { TranscriptSegmentData } from "@/types";
import { getSpeakerChipStyle } from "@/lib/speaker";
import { Pencil } from "lucide-react";
import { cn } from "@/lib/utils";

export interface VirtualizedTranscriptViewProps {
    /** Transcript segments to display */
    segments: TranscriptSegmentData[];
    /** Whether recording is in progress */
    isRecording?: boolean;
    /** Whether recording is paused */
    isPaused?: boolean;
    /** Whether processing/finalizing transcription */
    isProcessing?: boolean;
    /** Whether stopping */
    isStopping?: boolean;
    /** Enable streaming effect for latest segment */
    enableStreaming?: boolean;
    /** Completely disable auto-scroll behavior (for meeting details page) */
    disableAutoScroll?: boolean;
    /** Show the red radial welcome gradient behind the empty-state text (home page only) */
    showWelcomeGradient?: boolean;

    // Pagination props (infinite scroll)
    hasMore?: boolean;
    isLoadingMore?: boolean;
    totalCount?: number;
    loadedCount?: number;
    onLoadMore?: () => void;

    // Inline editing (meeting details page)
    editable?: boolean;
    onEditSegment?: (id: string, text: string, speaker?: string) => Promise<void>;
    onRenameSpeaker?: (oldSpeaker: string, newSpeaker: string) => Promise<void>;
}

// Threshold for enabling virtualization (below this, use simple rendering)
const VIRTUALIZATION_THRESHOLD = 10;

// Helper function to format seconds as recording-relative time [MM:SS]
function formatRecordingTime(seconds: number | undefined): string {
    if (seconds === undefined) return '[--:--]';

    const totalSeconds = Math.floor(seconds);
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;

    return `[${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
}

// Helper function to remove filler words and repetitions
function cleanStopWords(text: string): string {
    const stopWords = ['uh', 'um', 'er', 'ah', 'hmm', 'hm', 'eh', 'oh'];

    let cleanedText = text;
    stopWords.forEach(word => {
        const pattern = new RegExp(`\\b${word}\\b[,\\s]*`, 'gi');
        cleanedText = cleanedText.replace(pattern, ' ');
    });

    return cleanedText.replace(/\s+/g, ' ').trim();
}

// Memoized transcript segment component
const TranscriptSegment = memo(function TranscriptSegment({
    id,
    timestamp,
    text,
    speaker,
    isStreaming,
    editable = false,
    onEditSegment,
    onRenameSpeaker,
}: {
    id: string;
    timestamp: number | null;
    text: string;
    speaker?: string;
    isStreaming: boolean;
    editable?: boolean;
    onEditSegment?: (id: string, text: string, speaker?: string) => Promise<void>;
    onRenameSpeaker?: (oldSpeaker: string, newSpeaker: string) => Promise<void>;
}) {
    const { t } = useTranslation();
    const [isEditing, setIsEditing] = useState(false);
    const [editText, setEditText] = useState('');
    const [editSpeaker, setEditSpeaker] = useState('');
    const [applyToAll, setApplyToAll] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    const displayText = cleanStopWords(text) || (text.trim() === '' ? '[Silence]' : text);

    const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);

    // Fit the edit textarea to its content (max height capped via CSS)
    const autoResizeTextarea = () => {
        const el = editTextareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight + 2}px`;
    };

    useEffect(() => {
        if (isEditing) autoResizeTextarea();
    }, [isEditing]);

    const startEditing = () => {
        setEditText(text);
        setEditSpeaker(speaker ?? '');
        setApplyToAll(false);
        setIsEditing(true);
    };

    const handleSave = async () => {
        if (!onEditSegment) return;
        setIsSaving(true);
        try {
            const newSpeaker = editSpeaker.trim() || undefined;
            // Global rename first; the per-segment update below covers this row
            if (applyToAll && speaker && newSpeaker && newSpeaker !== speaker && onRenameSpeaker) {
                await onRenameSpeaker(speaker, newSpeaker);
            }
            await onEditSegment(id, editText.trim(), newSpeaker);
            setIsEditing(false);
        } catch (err) {
            console.error('Failed to save transcript edit:', err);
            alert(t('transcriptEdit.saveFailed'));
        } finally {
            setIsSaving(false);
        }
    };

    // Colored speaker chip (S1, S2, ...) shown before the segment text.
    // Colors are inline styles so they survive Tailwind's purge.
    const speakerChip = speaker ? (
        <span className="inline-block text-[11px] font-medium px-1.5 py-0.5 rounded mr-1.5 align-middle" style={getSpeakerChipStyle(speaker)}>
            {speaker}
        </span>
    ) : null;

    return (
        <div id={`segment-${id}`} className="mb-3 group">
            <div className="flex items-start gap-2">
                {timestamp != null && (
                    <span className="text-xs text-gray-400 mt-1 flex-shrink-0 min-w-[50px]">
                        {formatRecordingTime(timestamp)}
                    </span>
                )}
                <div className="flex-1">
                    {isEditing ? (
                        <div className="border border-blue-200 rounded-lg p-2 bg-blue-50/50 space-y-2">
                            <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs text-gray-500">{t('transcriptEdit.speaker')}</span>
                                <input
                                    type="text"
                                    value={editSpeaker}
                                    onChange={(e) => setEditSpeaker(e.target.value)}
                                    placeholder={t('transcriptEdit.speakerPlaceholder')}
                                    className="px-2 py-0.5 text-xs border border-gray-300 rounded w-28 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                                />
                                {speaker && (
                                    <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={applyToAll}
                                            onChange={(e) => setApplyToAll(e.target.checked)}
                                        />
                                        {t('transcriptEdit.applyToAll', { speaker })}
                                    </label>
                                )}
                            </div>
                            <textarea
                                ref={editTextareaRef}
                                value={editText}
                                onChange={(e) => {
                                    setEditText(e.target.value);
                                    autoResizeTextarea();
                                }}
                                className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded resize-y min-h-[60px] max-h-[40vh] overflow-y-auto bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={() => setIsEditing(false)}
                                    disabled={isSaving}
                                    className="px-2 py-0.5 text-xs text-gray-500 hover:text-gray-700"
                                >
                                    {t('transcriptEdit.cancel')}
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={isSaving || !editText.trim()}
                                    className="px-2.5 py-0.5 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
                                >
                                    {isSaving ? t('transcriptEdit.saving') : t('transcriptEdit.save')}
                                </button>
                            </div>
                        </div>
                    ) : isStreaming ? (
                        <div className="bg-gray-100 border border-gray-200 rounded-lg px-3 py-2">
                            <p className="text-base text-gray-800 leading-relaxed">{speakerChip}{displayText}</p>
                        </div>
                    ) : (
                        <p className="text-base text-gray-800 leading-relaxed">{speakerChip}{displayText}</p>
                    )}
                </div>
                {editable && !isEditing && onEditSegment && (
                    <button
                        onClick={startEditing}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-blue-500 mt-1.5 flex-shrink-0"
                        title={t('transcriptEdit.editTooltip')}
                    >
                        <Pencil className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>
        </div>
    );
});

export const VirtualizedTranscriptView: React.FC<VirtualizedTranscriptViewProps> = ({
    segments,
    isRecording = false,
    isPaused = false,
    isProcessing = false,
    isStopping = false,
    enableStreaming = false,
    disableAutoScroll = false,
    showWelcomeGradient = false,
    hasMore = false,
    isLoadingMore = false,
    totalCount = 0,
    loadedCount = 0,
    onLoadMore,
    editable = false,
    onEditSegment,
    onRenameSpeaker,
}) => {
    const { t } = useTranslation();
    // Create scroll ref first - shared between virtualizer and auto-scroll hook
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ref for infinite scroll trigger element
    const loadMoreTriggerRef = useRef<HTMLDivElement>(null);

    // Force re-render without flushSync (avoids React warning)
    const [, rerender] = useReducer((x: number) => x + 1, 0);

    // Setup virtualizer for efficient rendering of large lists
    const virtualizer = useVirtualizer({
        count: segments.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 60, // Estimated height per segment
        overscan: 10, // Render extra items above/below viewport
        onChange: () => {
            startTransition(() => {
                rerender();
            });
        },
    });

    // Custom hook for auto-scrolling (supports both virtualized and non-virtualized)
    useAutoScroll({
        scrollRef,
        segments,
        isRecording,
        isPaused,
        virtualizer,
        virtualizationThreshold: VIRTUALIZATION_THRESHOLD,
        disableAutoScroll,
    });

    // Streaming text effect hook (typewriter animation for new transcripts)
    const { streamingSegmentId, getDisplayText } = useTranscriptStreaming(
        segments,
        isRecording,
        enableStreaming
    );

    // Infinite scroll: IntersectionObserver to trigger loading more
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording || segments.length === 0) {
            return;
        }

        const triggerElement = loadMoreTriggerRef.current;
        if (!triggerElement) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
            },
            {
                root: null,
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(triggerElement);

        return () => observer.disconnect();
    }, [hasMore, isLoadingMore, onLoadMore, isRecording, segments.length]);

    // Scroll-based fallback for fast scrolling
    useEffect(() => {
        if (!onLoadMore || !hasMore || isLoadingMore || isRecording) return;

        const scrollElement = scrollRef.current;
        if (!scrollElement) return;

        let ticking = false;

        const handleScroll = () => {
            if (ticking || isLoadingMore || !hasMore) return;

            ticking = true;
            requestAnimationFrame(() => {
                const { scrollTop, scrollHeight, clientHeight } = scrollElement;
                const scrollBottom = scrollHeight - scrollTop - clientHeight;

                // Trigger load when within 200px of bottom
                if (scrollBottom < 200 && hasMore && !isLoadingMore) {
                    onLoadMore();
                }
                ticking = false;
            });
        };

        scrollElement.addEventListener('scroll', handleScroll, { passive: true });
        return () => scrollElement.removeEventListener('scroll', handleScroll);
    }, [onLoadMore, hasMore, isLoadingMore, isRecording]);

    // Use simple rendering for small lists, virtualization for large lists
    const useVirtualization = segments.length >= VIRTUALIZATION_THRESHOLD;

    // Home-page empty state with centered red radial gradient behind the welcome text.
    // This deliberately moves the welcome text down so it aligns with the gradient center.
    const shouldShowWelcomeGradient = showWelcomeGradient && segments.length === 0 && !isRecording;

    return (
        <div
            ref={scrollRef}
            className={cn(
                "flex flex-col h-full px-4 py-2",
                shouldShowWelcomeGradient ? "overflow-visible relative" : "overflow-y-auto"
            )}
        >
            {/* Recording Status Bar - Sticky at top, always visible when recording */}
            <AnimatePresence>
                {isRecording && (
                    <div className="sticky top-0 z-10 bg-white pb-2">
                        <RecordingStatusBar isPaused={isPaused} />
                    </div>
                )}
            </AnimatePresence>

            {/* Content - add padding when recording to prevent overlap */}
            <div className={isRecording ? 'pt-2' : ''}>
            {segments.length === 0 ? (
                // Empty state
                shouldShowWelcomeGradient ? (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="min-h-[58vh] w-full flex flex-col items-center justify-center relative text-center text-gray-500"
                    >
                        {/* Red radial gradient centered with the text */}
                        <div className="absolute inset-0 pointer-events-none overflow-hidden">
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                <motion.div
                                    className="rounded-full"
                                    style={{
                                        width: 320,
                                        height: 320,
                                        background: 'radial-gradient(circle, rgba(239, 68, 68, 0.18) 0%, rgba(239, 68, 68, 0.05) 50%, transparent 70%)',
                                        filter: 'blur(32px)',
                                    }}
                                    animate={{
                                        scale: [1, 1.08, 1],
                                        opacity: [1, 0.85, 1],
                                    }}
                                    transition={{
                                        duration: 4,
                                        repeat: Infinity,
                                        ease: 'easeInOut',
                                    }}
                                />
                            </div>
                            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                <motion.div
                                    className="rounded-full"
                                    style={{
                                        width: 520,
                                        height: 520,
                                        background: 'radial-gradient(circle, rgba(239, 68, 68, 0.08) 0%, rgba(239, 68, 68, 0.02) 45%, transparent 70%)',
                                        filter: 'blur(40px)',
                                    }}
                                    animate={{
                                        scale: [1, 1.12, 1],
                                        opacity: [1, 0.75, 1],
                                    }}
                                    transition={{
                                        duration: 5,
                                        repeat: Infinity,
                                        repeatType: 'reverse',
                                        ease: 'easeInOut',
                                    }}
                                />
                            </div>
                        </div>
                        <div className="relative z-10">
                            <p className="text-lg font-semibold">{t('transcript.welcomeTitle')}</p>
                            <p className="text-xs mt-1">{t('transcript.welcomeSubtitle')}</p>
                        </div>
                    </motion.div>
                ) : (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="text-center text-gray-500 mt-8"
                    >
                        {isRecording ? (
                            <>
                                <div className="flex items-center justify-center mb-3">
                                    <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-blue-500 animate-pulse'}`}></div>
                                </div>
                                <p className="text-sm text-gray-600">
                                    {isPaused ? t('transcript.recordingPaused') : t('transcript.listeningForSpeech')}
                                </p>
                                <p className="text-xs mt-1 text-gray-400">
                                    {isPaused ? t('transcript.clickResume') : t('transcript.speakToSee')}
                                </p>
                            </>
                        ) : (
                            <>
                                <p className="text-lg font-semibold">{t('transcript.welcomeTitle')}</p>
                                <p className="text-xs mt-1">{t('transcript.welcomeSubtitle')}</p>
                            </>
                        )}
                    </motion.div>
                )
            ) : useVirtualization ? (
                // Virtualized rendering for large lists
                <>
                    <div
                        style={{
                            height: virtualizer.getTotalSize(),
                            width: "100%",
                            position: "relative",
                        }}
                    >
                        {virtualizer.getVirtualItems().map((virtualRow) => {
                            const segment = segments[virtualRow.index];
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <div
                                    key={segment.id}
                                    data-index={virtualRow.index}
                                    ref={virtualizer.measureElement}
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: "100%",
                                        transform: `translateY(${virtualRow.start}px)`,
                                    }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        speaker={segment.speaker}
                                        isStreaming={isStreaming}
                                        editable={editable}
                                        onEditSegment={onEditSegment}
                                        onRenameSpeaker={onRenameSpeaker}
                                    />
                                </div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger and loading indicator */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">{t('transcript.loadingMore')}</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    {t('transcript.showingSegments', { loaded: loadedCount, total: totalCount })}
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">{t('transcript.listening')}</span>
                        </motion.div>
                    )}
                </>
            ) : (
                // Simple rendering for small lists (better animations)
                <>
                    <div className="space-y-1">
                        {segments.map((segment) => {
                            const isStreaming = streamingSegmentId === segment.id;

                            return (
                                <motion.div
                                    key={segment.id}
                                    initial={{ opacity: 0, y: 5 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    transition={{ duration: 0.15 }}
                                >
                                    <TranscriptSegment
                                        id={segment.id}
                                        timestamp={segment.timestamp}
                                        text={getDisplayText(segment)}
                                        speaker={segment.speaker}
                                        isStreaming={isStreaming}
                                        editable={editable}
                                        onEditSegment={onEditSegment}
                                        onRenameSpeaker={onRenameSpeaker}
                                    />
                                </motion.div>
                            );
                        })}
                    </div>

                    {/* Infinite scroll trigger (for small lists that grow) */}
                    {(hasMore || isLoadingMore) && !isRecording && segments.length > 0 && (
                        <div ref={loadMoreTriggerRef} className="flex justify-center items-center py-4 mt-2">
                            {isLoadingMore ? (
                                <div className="flex items-center gap-2 text-gray-500">
                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
                                    <span className="text-sm">{t('transcript.loadingMore')}</span>
                                </div>
                            ) : hasMore && totalCount > 0 ? (
                                <span className="text-sm text-gray-400">
                                    {t('transcript.showingSegments', { loaded: loadedCount, total: totalCount })}
                                </span>
                            ) : null}
                        </div>
                    )}

                    {/* Listening indicator when recording */}
                    {!isStopping && isRecording && !isPaused && !isProcessing && segments.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="flex items-center gap-2 mt-4 text-gray-500"
                        >
                            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse"></div>
                            <span className="text-sm">{t('transcript.listening')}</span>
                        </motion.div>
                    )}
                </>
            )}
            </div>
        </div>
    );
};
