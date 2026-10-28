'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FolderSearch, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SenseVoiceAPI } from '@/lib/sensevoice';

interface AddCustomAsrModelDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

interface KindOption {
  value: string;
  label: string;
  // i18n key under customAsr.dialog.*
  descriptionKey: string;
  requiredFiles: string;
}

// Recognizer families supported by the bundled sherpa-onnx runtime. The file
// requirements mirror backend catalog::required_files_for_kind.
const KIND_OPTIONS: KindOption[] = [
  {
    value: 'sense_voice',
    label: 'SenseVoice',
    descriptionKey: 'kindSenseVoice',
    requiredFiles: 'model.int8.onnx + tokens.txt',
  },
  {
    value: 'fire_red_ctc',
    label: 'FireRedASR v2 (CTC)',
    descriptionKey: 'kindFireRed',
    requiredFiles: 'model.int8.onnx + tokens.txt',
  },
  {
    value: 'fun_asr_nano',
    label: 'Fun-ASR-Nano',
    descriptionKey: 'kindFunAsr',
    requiredFiles: 'encoder_adaptor.int8.onnx + llm.int8.onnx + embedding.int8.onnx + Qwen3-0.6B/{merges.txt,tokenizer.json,vocab.json}',
  },
  {
    value: 'qwen3_asr',
    label: 'Qwen3-ASR',
    descriptionKey: 'kindQwen3',
    requiredFiles: 'conv_frontend.onnx + encoder.int8.onnx + decoder.int8.onnx + tokenizer/{merges.txt,tokenizer_config.json,vocab.json}',
  },
];

export function AddCustomAsrModelDialog({
  open,
  onClose,
  onAdded,
}: AddCustomAsrModelDialogProps) {
  const { t } = useTranslation();
  const [sourceDir, setSourceDir] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');
  const [kind, setKind] = useState<string>('sense_voice');
  const [languages, setLanguages] = useState<string>('auto');
  const [note, setNote] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const selectSourceDir = async () => {
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: t('customAsr.dialog.pickFolderTitle'),
      });
      if (selected) {
        const path = Array.isArray(selected) ? selected[0] : selected;
        setSourceDir(path);
        // Auto-fill name from the folder name if empty
        if (!name) {
          const folderName = path.split(/[/\\]/).filter(Boolean).pop() || '';
          setName(folderName.replace(/\s+/g, '-').toLowerCase());
          if (!displayName) {
            setDisplayName(folderName);
          }
        }
      }
    } catch (error) {
      console.error('Failed to open folder dialog:', error);
      toast.error(t('customAsr.dialog.folderDialogFailed'));
    }
  };

  const selectedKind = KIND_OPTIONS.find((k) => k.value === kind);

  const canSubmit =
    sourceDir.length > 0 &&
    name.trim().length > 0 &&
    displayName.trim().length > 0 &&
    !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      const languageList = languages
        .split(/[,，\s]+/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      await SenseVoiceAPI.addCustomModel({
        name: name.trim(),
        displayName: displayName.trim(),
        kind,
        sourceDir,
        languages: languageList,
        note: note.trim(),
      });
      toast.success(t('customAsr.dialog.addedToast', { name: displayName.trim() }));
      // Reset form
      setSourceDir('');
      setName('');
      setDisplayName('');
      setKind('sense_voice');
      setLanguages('auto');
      setNote('');
      onClose();
      onAdded();
    } catch (error) {
      console.error('Failed to add custom ASR model:', error);
      toast.error(t('customAsr.dialog.addFailedToast', { error: String(error) }));
    } finally {
      setIsSubmitting(false);
    }
  };

  const folderName = sourceDir.split(/[/\\]/).filter(Boolean).pop() || '';

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('customAsr.dialog.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          <div className="rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
            {t('customAsr.dialog.offlineHint')}
          </div>

          {/* Step 1: Model family */}
          <div className="space-y-2">
            <Label>{t('customAsr.dialog.kindLabel')}*</Label>
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-gray-800"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {KIND_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            {selectedKind && (
              <div className="text-xs text-gray-500 space-y-1">
                <p>{t(`customAsr.dialog.${selectedKind.descriptionKey}`)}</p>
                <p className="font-mono break-all">{t('customAsr.dialog.requiredFiles')}：{selectedKind.requiredFiles}</p>
              </div>
            )}
          </div>

          {/* Step 2: Source folder */}
          <div className="space-y-2">
            <Label>{t('customAsr.dialog.folderLabel')}*</Label>
            <div className="flex gap-2">
              <div className="flex-1 flex items-center rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm min-w-0">
                {sourceDir ? (
                  <span className="truncate" title={sourceDir}>
                    {folderName}
                  </span>
                ) : (
                  <span className="text-gray-400">{t('customAsr.dialog.noFolder')}</span>
                )}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={selectSourceDir}>
                <FolderSearch className="mr-2 h-4 w-4" />
                {t('customAsr.dialog.browse')}
              </Button>
            </div>
            <p className="text-xs text-gray-500">
              {t('customAsr.dialog.folderHint')}
            </p>
          </div>

          {/* Step 3: Model name */}
          <div className="space-y-2">
            <Label>{t('customAsr.dialog.nameLabel')}*</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('customAsr.dialog.namePlaceholder')}
            />
            <p className="text-xs text-gray-500">{t('customAsr.dialog.nameHint')}</p>
          </div>

          {/* Step 4: Display name */}
          <div className="space-y-2">
            <Label>{t('customAsr.dialog.displayNameLabel')}*</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t('customAsr.dialog.displayNamePlaceholder')}
            />
          </div>

          {/* Step 5: Languages */}
          <div className="space-y-2">
            <Label>{t('customAsr.dialog.languagesLabel')}</Label>
            <Input
              value={languages}
              onChange={(e) => setLanguages(e.target.value)}
              placeholder="auto, zh, en, ja, ko, yue"
            />
            <p className="text-xs text-gray-500">
              {t('customAsr.dialog.languagesHint')}
            </p>
          </div>

          {/* Step 6: Note */}
          <div className="space-y-2">
            <Label>{t('customAsr.dialog.noteLabel')}</Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('customAsr.dialog.notePlaceholder')}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {isSubmitting ? t('customAsr.dialog.copying') : t('customAsr.add')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
