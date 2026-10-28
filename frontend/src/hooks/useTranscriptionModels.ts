import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { AsrKind } from '@/lib/asr-languages';

export interface RawModelInfo {
  name: string;
  kind?: AsrKind;
  display_name?: string;
  size_mb: number;
  languages?: string[];
  note?: string;
  status: 'Available' | 'Missing' | { Downloading: { progress: number } } | { Error: string };
}

export interface ModelOption {
  provider: 'sensevoice';
  name: string;
  kind?: AsrKind;
  displayName: string;
  size_mb: number;
  languages: string[];
}

interface TranscriptModelConfig {
  provider?: string;
  model?: string;
}

/**
 * Custom hook for fetching and managing transcription models (Whisper and Parakeet).
 *
 * This hook centralizes the model fetching logic that was previously duplicated
 * in ImportAudioDialog and RetranscribeDialog components.
 *
 * @param transcriptModelConfig - User's saved model configuration from context
 * @returns Object containing available models, selected model key, loading state, and fetch function
 */
export function useTranscriptionModels(transcriptModelConfig: TranscriptModelConfig | undefined) {
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState<string>('');
  const [loadingModels, setLoadingModels] = useState(false);
  // Track whether the user has manually changed the model selection
  const userSelectedRef = useRef(false);

  // Wrap setSelectedModelKey to track user-initiated changes
  const setSelectedModelKeyWithTracking = useCallback((key: string) => {
    userSelectedRef.current = true;
    setSelectedModelKey(key);
  }, []);

  const fetchModels = useCallback(async () => {
    setLoadingModels(true);
    const allModels: ModelOption[] = [];

    // Local ASR catalog (SenseVoice / FireRedASR v2 / Fun-ASR-Nano / Qwen3-ASR).
    // Whisper and Parakeet left the selectable lineup; stored legacy configs
    // are normalized to sensevoice by the backend.
    try {
      const sensevoiceModels = await invoke<RawModelInfo[]>('sensevoice_get_available_models');
      const availableSenseVoice = sensevoiceModels
        .filter((m) => m.status === 'Available')
        .map((m) => ({
          provider: 'sensevoice' as const,
          name: m.name,
          kind: m.kind,
          displayName: m.display_name || m.name,
          size_mb: m.size_mb,
          languages: m.languages || [],
        }));
      allModels.push(...availableSenseVoice);
    } catch (err) {
      console.error('Failed to fetch local ASR models:', err);
    }

    setAvailableModels(allModels);

    // Set default model based on user's saved configuration
    const configuredProvider = transcriptModelConfig?.provider || '';
    const configuredModel = transcriptModelConfig?.model || '';

    // Try to match the configured model (legacy providers normalize to sensevoice)
    const configuredMatch = allModels.find(
      (m) => m.provider === 'sensevoice' && m.name === configuredModel
    );

    // Only set default model if user hasn't manually selected one
    if (!userSelectedRef.current) {
      if (configuredMatch) {
        // Use the configured model if available
        setSelectedModelKey(`${configuredMatch.provider}:${configuredMatch.name}`);
      } else if (allModels.length > 0) {
        // Fall back to first available model
        setSelectedModelKey(`${allModels[0].provider}:${allModels[0].name}`);
      }
    }

    setLoadingModels(false);
  }, [transcriptModelConfig]);

  // Reset user selection tracking (call when dialog opens fresh)
  const resetSelection = useCallback(() => {
    userSelectedRef.current = false;
  }, []);

  return {
    availableModels,
    selectedModelKey,
    setSelectedModelKey: setSelectedModelKeyWithTracking,
    loadingModels,
    fetchModels,
    resetSelection,
  };
}
