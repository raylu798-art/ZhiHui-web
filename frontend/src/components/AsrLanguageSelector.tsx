import { useId } from 'react';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import {
  ASR_LANGUAGES, CHINESE_DIALECTS, AsrLanguageModel,
  getAsrPrimaryLanguage, getAsrLanguageHint, isExperimentalDialect, supportsAsrLanguage,
} from '@/lib/asr-languages';

interface AsrLanguageSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  model?: AsrLanguageModel;
  disabled?: boolean;
}

export function AsrLanguageSelector({ value, onValueChange, model, disabled }: AsrLanguageSelectorProps) {
  const id = useId();
  const primaryLanguage = getAsrPrimaryLanguage(value);
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-language`}>识别语言</Label>
          <Select value={primaryLanguage} onValueChange={onValueChange} disabled={disabled || !model}>
            <SelectTrigger id={`${id}-language`} aria-describedby={`${id}-hint`}>
              <SelectValue placeholder="自动" />
            </SelectTrigger>
            <SelectContent>
              {ASR_LANGUAGES.filter((language) => supportsAsrLanguage(model, language.value)).map((language) => (
                <SelectItem key={language.value} value={language.value}>
                  {language.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {primaryLanguage === 'zh' && (
          <div className="space-y-1">
            <Label htmlFor={`${id}-dialect`}>中文方言</Label>
            <Select value={value} onValueChange={onValueChange} disabled={disabled || !model}>
              <SelectTrigger id={`${id}-dialect`} aria-describedby={`${id}-hint`}>
                <SelectValue placeholder="自动" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {CHINESE_DIALECTS.filter((dialect) => supportsAsrLanguage(model, dialect.value)).map((dialect) => (
                  <SelectItem key={dialect.value} value={dialect.value}>
                    {dialect.label}{isExperimentalDialect(model, dialect.value) ? '（实验）' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground" role="status">
        {getAsrLanguageHint(model, value)}
      </p>
    </div>
  );
}
