// Types and API wrappers for SenseVoice (FunAudioLLM) integration
import i18n from '@/lib/i18n/config';
import { invoke } from '@tauri-apps/api/core';
import type { AsrKind } from './asr-languages';

export type SenseVoiceModelStatus =
  | 'Available'
  | 'Missing'
  | { Downloading: { progress: number; downloadedMb?: number; totalMb?: number; extracting?: boolean } };

export interface SenseVoiceModelInfo {
  name: string;
  kind?: AsrKind;
  display_name: string;
  status: SenseVoiceModelStatus;
  size_mb: number;
  path: string;
  languages: string[];
  note: string;
}

// User-friendly model display configuration
export interface SenseVoiceModelDisplayInfo {
  friendlyName: string;
  icon: string;
  tagline: string;
}

export const SENSEVOICE_MODEL_DISPLAY_CONFIG: Record<string, SenseVoiceModelDisplayInfo> = {
  'sense-voice-small-int8': {
    friendlyName: 'SenseVoice Small',
    icon: '🎙️',
    tagline: '中文优化 • zh/en/ja/ko/yue • 内置标点'
  },
  'fireredasr2-ctc-int8': {
    friendlyName: 'FireRedASR v2 (CTC)',
    icon: '🔥',
    tagline: '普通话+20 种中国方言自动识别 • CPU 快'
  },
  'funasr-nano-2512-int8': {
    friendlyName: 'Fun-ASR-Nano-2512',
    icon: '🎯',
    tagline: '方言/远场/高噪深度优化 • 精度高 • CPU 较慢'
  },
  'qwen3-asr-0.6b-int8': {
    friendlyName: 'Qwen3-ASR 0.6B',
    icon: '🧠',
    tagline: '多语言（含中文方言）自动识别 • 精度高 • CPU 较慢'
  }
};

// Get model display info localized via i18n (falls back to built-in text)
export function getSenseVoiceModelDisplayInfo(modelName: string): SenseVoiceModelDisplayInfo | null {
  const info = SENSEVOICE_MODEL_DISPLAY_CONFIG[modelName];
  if (!info) return null;
  const key = modelName.replace(/[^a-zA-Z0-9]/g, '_');
  return {
    ...info,
    friendlyName: i18n.t(`sensevoiceModels.names.${key}`, { defaultValue: info.friendlyName }),
    tagline: i18n.t(`sensevoiceModels.taglines.${key}`, { defaultValue: info.tagline }),
  };
}

export function getSenseVoiceModelDisplayName(modelName: string): string {
  return getSenseVoiceModelDisplayInfo(modelName)?.friendlyName || modelName;
}

// Normalize download progress out of the serde-tagged status shape
export function getSenseVoiceDownloadProgress(status: SenseVoiceModelStatus): number | null {
  if (typeof status === 'object' && 'Downloading' in status) {
    const value = status.Downloading as { progress: number } | number;
    return typeof value === 'number' ? value : value.progress;
  }
  return null;
}

// Tauri command wrappers for the SenseVoice backend
export class SenseVoiceAPI {
  static async init(): Promise<void> {
    await invoke('sensevoice_init');
  }

  static async getAvailableModels(): Promise<SenseVoiceModelInfo[]> {
    return await invoke('sensevoice_get_available_models');
  }

  static async loadModel(modelName: string, language?: string): Promise<void> {
    await invoke('sensevoice_load_model', { modelName, language: language ?? null });
  }

  static async getCurrentModel(): Promise<string | null> {
    return await invoke('sensevoice_get_current_model');
  }

  static async isModelLoaded(): Promise<boolean> {
    return await invoke('sensevoice_is_model_loaded');
  }

  static async hasAvailableModels(): Promise<boolean> {
    return await invoke('sensevoice_has_available_models');
  }

  static async getModelsDirectory(): Promise<string> {
    return await invoke('sensevoice_get_models_directory');
  }

  static async downloadModel(modelName: string): Promise<void> {
    await invoke('sensevoice_download_model', { modelName });
  }

  static async cancelDownload(modelName: string): Promise<void> {
    await invoke('sensevoice_cancel_download', { modelName });
  }

  static async retryDownload(modelName: string): Promise<void> {
    await invoke('sensevoice_retry_download', { modelName });
  }

  static async deleteModel(modelName: string): Promise<string> {
    return await invoke('sensevoice_delete_model', { modelName });
  }

  static async addCustomModel(params: {
    name: string;
    displayName: string;
    kind: string;
    sourceDir: string;
    languages: string[];
    note: string;
  }): Promise<string> {
    return await invoke('sensevoice_add_custom_model', { params });
  }

  static async openModelsFolder(): Promise<void> {
    await invoke('open_sensevoice_models_folder');
  }
}
