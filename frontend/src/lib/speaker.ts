// Types, API wrappers and preference storage for speaker diarization
import { invoke } from '@tauri-apps/api/core';

const CLUSTER_MERGE_KEY = 'speakerClusterMergeEnabled';

export interface SpeakerModelInfo {
  name: string;
  available: boolean;
  downloading: boolean;
  progress: number;
  size_mb: number;
  path: string;
}

// Local preference persistence (backend flag is process-local, so the
// stored preference is pushed to the backend on load and before recording)
export function getSpeakerEnabledPreference(): boolean {
  // Speaker diarization is a core capability: always on, not user-toggleable.
  return true;
}

export function setSpeakerEnabledPreference(_enabled: boolean): void {
  // No-op: kept for call-site compatibility; the capability cannot be disabled.
}

// Cluster-level re-verification for offline diarization. Experimental but on
// by default to reduce mis-attribution; user can turn it off to compare.
export function getClusterMergePreference(): boolean {
  if (typeof window === 'undefined') return true;
  return localStorage.getItem(CLUSTER_MERGE_KEY) !== 'false';
}

export function setClusterMergePreference(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CLUSTER_MERGE_KEY, String(enabled));
}

// Tauri command wrappers for the speaker diarization backend
export class SpeakerAPI {
  static async getModelInfo(): Promise<SpeakerModelInfo> {
    return await invoke('speaker_get_model_info');
  }

  static async setEnabled(enabled: boolean): Promise<void> {
    await invoke('speaker_set_enabled', { enabled });
  }

  static async getEnabled(): Promise<boolean> {
    return await invoke('speaker_get_enabled');
  }

  static async setClusterMerge(enabled: boolean): Promise<void> {
    await invoke('speaker_set_cluster_merge', { enabled });
  }

  static async getClusterMerge(): Promise<boolean> {
    return await invoke('speaker_get_cluster_merge');
  }

  static async downloadModel(): Promise<void> {
    await invoke('speaker_download_model');
  }

  static async cancelDownload(): Promise<void> {
    await invoke('speaker_cancel_download');
  }

  static async deleteModel(): Promise<void> {
    await invoke('speaker_delete_model');
  }
}

// Push the stored preferences to the backend; called on settings load and
// before each recording start so labels honor the user's last choice.
export async function syncSpeakerEnabledToBackend(): Promise<void> {
  try {
    await SpeakerAPI.setEnabled(getSpeakerEnabledPreference());
    await SpeakerAPI.setClusterMerge(getClusterMergePreference());
  } catch (err) {
    console.warn('Failed to sync speaker diarization preference:', err);
  }
}

// Deterministic chip color per speaker label (S1, S2, ... cycle).
// Inline styles instead of Tailwind classes: the color is chosen at runtime,
// and Tailwind's purge cannot see class names that only exist in this array
// (src/lib is outside the configured content globs), which silently dropped
// the background for some speakers.
const SPEAKER_CHIP_COLORS: { bg: string; fg: string }[] = [
  { bg: '#dbeafe', fg: '#1d4ed8' }, // blue
  { bg: '#dcfce7', fg: '#15803d' }, // green
  { bg: '#f3e8ff', fg: '#7e22ce' }, // purple
  { bg: '#ffedd5', fg: '#c2410c' }, // orange
  { bg: '#fce7f3', fg: '#be185d' }, // pink
  { bg: '#ccfbf1', fg: '#0f766e' }, // teal
  { bg: '#fee2e2', fg: '#b91c1c' }, // red
  { bg: '#e0e7ff', fg: '#4338ca' }, // indigo
];

export function getSpeakerChipStyle(label: string): { backgroundColor: string; color: string } {
  const match = /^S(\d+)$/.exec(label);
  const index = match
    ? (parseInt(match[1], 10) - 1) % SPEAKER_CHIP_COLORS.length
    : Math.abs(label.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 0)) % SPEAKER_CHIP_COLORS.length;
  const c = SPEAKER_CHIP_COLORS[index];
  return { backgroundColor: c.bg, color: c.fg };
}
