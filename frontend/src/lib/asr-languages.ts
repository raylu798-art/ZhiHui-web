export type AsrKind = 'sense_voice' | 'fire_red_ctc' | 'fun_asr_nano' | 'qwen3_asr';

export interface AsrLanguageModel {
  kind?: AsrKind;
  languages: readonly string[];
}

export const ASR_LANGUAGES = [
  { value: 'auto', label: '自动' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英文' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'fr', label: '法语' },
  { value: 'de', label: '德语' },
] as const;

// Keep the existing zh / yue values compatible with saved configurations.
// zh:* values are application selections, never native model language codes.
export const CHINESE_DIALECTS = [
  { value: 'zh', label: '自动' },
  { value: 'zh:mandarin', label: '普通话' },
  { value: 'yue', label: '粤语' },
  { value: 'zh:wu', label: '吴语' },
  { value: 'zh:minnan', label: '闽南语' },
  { value: 'zh:hakka', label: '客家话' },
  { value: 'zh:gan', label: '赣语' },
  { value: 'zh:xiang', label: '湘语' },
  { value: 'zh:jin', label: '晋语' },
  { value: 'zh:gan-ning', label: '甘肃宁夏方言' },
] as const;

export function getAsrPrimaryLanguage(value: string): string {
  return value === 'yue' || value.startsWith('zh:') ? 'zh' : value;
}

export function supportsAsrLanguage(model: AsrLanguageModel | undefined, value: string): boolean {
  return value === 'auto' || !!model?.languages.includes(value);
}

export function normalizeAsrLanguage(value: string | undefined, model: AsrLanguageModel | undefined): string {
  const selection = value || 'auto';
  // Preserve saved preferences while the catalog is loading.
  return !model || supportsAsrLanguage(model, selection) ? selection : 'auto';
}

export function isExperimentalDialect(model: AsrLanguageModel | undefined, value: string): boolean {
  if (!CHINESE_DIALECTS.some((dialect) => dialect.value === value) || value === 'zh') return false;
  return model?.kind === 'fun_asr_nano' ||
    (model?.kind === 'qwen3_asr' && value !== 'yue');
}

export function getAsrLanguageHint(model: AsrLanguageModel | undefined, value: string): string {
  if (!model) return '请选择可用的识别模型后设置语言。';
  if (!supportsAsrLanguage(model, value)) return '当前模型不支持此选择，请重新选择语言。';
  if (isExperimentalDialect(model, value)) {
    return '方言提示引导（实验）：向模型提供方言提示，不是强制方言模式，也不代表模型已验证支持该方言。可与“中文 → 自动”对比测试。';
  }
  if (value === 'auto') {
    return model.languages.length <= 1
      ? '当前模型仅支持自动判断语言和方言。'
      : '由模型自动判断语言和方言；指定语言可用于对比识别效果。';
  }
  if (value === 'zh') return '指定中文，不附加细分方言提示，由模型判断具体方言。';
  if (model.kind === 'fun_asr_nano') return '通过模型的转写语言提示指定语言；识别效果仍取决于模型和音频。';
  return '已使用模型原生语言选项指定识别语言。';
}
