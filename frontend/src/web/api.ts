import product from '../../package.json';
export const VERSION = product.version;
export const BUILD = process.env.NEXT_PUBLIC_WEB_BUILD || '5';
export const TOKEN_PLAN_BASE_URL = 'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1';
export const DASHSCOPE_ASR_BASE_URL = 'https://dashscope.aliyuncs.com';
export const DASHSCOPE_SUMMARY_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export interface User { id: string; username: string; role: 'admin' | 'user'; disabled?: boolean }
export interface Meeting { id: string; title: string; created_at: string; updated_at: string; asset_id?: string | null }
export interface Transcript { id: string; meeting_id: string; transcript: string; timestamp: string; audio_start_time?: number | null; audio_end_time?: number | null; speaker?: string | null; source: string }
export interface Job { id: string; kind: 'transcribe' | 'summary'; meeting_id: string; state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'; progress: number; error?: string | null; created_at: string; updated_at: string }
export interface MeetingDetail { meeting: Meeting; transcripts: Transcript[]; summary: string; jobs: Job[]; recording_state?: 'pending' | 'running' | 'completed' | 'interrupted' | null }
export interface Template { id: string; name: string; description: string; prompt: string; builtin: boolean }
export interface CredentialSetting { configured: boolean; key_masked: string; provider: 'dashscope' | 'token_plan'; base_url: string; model: string; language?: string; region: string }
export interface AsrCapabilities { file_transcription: boolean; realtime: boolean; diarization: boolean; max_duration_seconds: number }
export interface Settings { asr: CredentialSetting & { capabilities?: AsrCapabilities }; summary: CredentialSetting }
export function asrUnavailableReason(settings: Settings | undefined, purpose: 'file_transcription' | 'realtime'): string {
  if (!settings) return '正在读取语音模型能力，请稍候。';
  if (!settings.asr.configured) return '请先在设置中配置语音 API Key。';
  if (!settings.asr.capabilities) return '尚未获取到语音接口能力，暂不提交音频任务。';
  if (!settings.asr.capabilities[purpose]) {
    if (purpose === 'file_transcription') return '当前接口尚不支持此语音模型的文件转写，文字导入仍可使用。';
    return settings.asr.capabilities.file_transcription ? '当前语音接口不支持边录边转写，可导入音频进行文件转写。' : '当前接口尚不支持此语音模型，文件转写与边录边转写暂未启用；仍可导入文字。';
  }
  return '';
}
export interface VersionInfo { version: string; build: string; icp_registration?: string | null; capabilities?: Record<string, unknown> }
export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', cache: 'no-store', signal, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.code || 'request_failed', data?.error?.message || `请求失败 (${res.status})`);
  return data as T;
}
export async function upload(file: File, progress: (percent: number) => void): Promise<{ id: string; name: string; size: number; mime_type: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest(); request.open('POST', '/api/v1/assets'); request.withCredentials = true;
    request.upload.onprogress = event => { if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100)); };
    request.onload = () => { try { const value = JSON.parse(request.responseText); if (request.status >= 200 && request.status < 300) resolve(value); else reject(new ApiError(request.status, value?.error?.code || 'upload_failed', value?.error?.message || '上传失败')); } catch { reject(new Error('服务器返回了无效的上传结果')); } };
    request.onerror = () => reject(new Error('网络中断，上传未完成'));
    const data = new FormData(); data.append('file', file); request.send(data);
  });
}
export function messageOf(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试'; }
export const isActiveJob = (job: Job) => job.state === 'queued' || job.state === 'running';
export function timeLabel(value: number | undefined): string { if (value === undefined || !Number.isFinite(value)) return ''; return `${Math.floor(value / 60).toString().padStart(2, '0')}:${Math.floor(value % 60).toString().padStart(2, '0')}`; }
