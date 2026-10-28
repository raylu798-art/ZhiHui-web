import type { TFunction } from 'i18next';

/**
 * Map known backend (Rust) error strings to localized user-facing messages.
 * Unknown errors pass through unchanged so diagnostics are never lost.
 */
export function localizeBackendError(error: string | null | undefined, t: TFunction): string {
  if (!error) return '';
  if (/FFmpeg conversion failed/i.test(error)) {
    const m = /exit code: (0x[0-9a-fA-F]+|-?\d+)/i.exec(error);
    return t('errors.ffmpegConversion', { code: m ? m[1] : '?' });
  }
  if (/All download sources failed for (.+)/i.test(error)) {
    const m = /All download sources failed for (.+)/i.exec(error);
    return t('errors.downloadSourcesFailed', { file: m ? m[1].trim() : '?' });
  }
  if (/Failed to start download/i.test(error)) {
    return t('errors.downloadStartFailed');
  }
  if (/error sending request|tcp connect error|deadline has elapsed|dns error/i.test(error)) {
    return t('errors.networkRequestFailed');
  }
  return error;
}
