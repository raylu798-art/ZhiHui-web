'use client';

import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FileSearch, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

interface AddCustomModelDialogProps {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}

interface TemplateOption {
  value: string;
  label: string;
  description: string;
}

const TEMPLATE_OPTIONS: TemplateOption[] = [
  {
    value: 'qwen3.5_nonthinking',
    label: 'Qwen 3 / 3.5 / 3.6',
    description: '适用于 Qwen 系列模型',
  },
  {
    value: 'gemma3',
    label: 'Gemma 3',
    description: '适用于 Google Gemma 3 系列模型',
  },
  {
    value: 'llama3',
    label: 'Llama 3.x',
    description: '适用于 Meta Llama 3.x 系列模型',
  },
  {
    value: 'chatml',
    label: 'ChatML 通用',
    description: '适用于 ChatML 格式的模型（如部分 Mistral、Phi 等）',
  },
];

const CONTEXT_SIZE_OPTIONS = [4096, 8192, 16384, 32768];

export function AddCustomModelDialog({
  open,
  onClose,
  onAdded,
}: AddCustomModelDialogProps) {
  const [ggufPath, setGgufPath] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [displayName, setDisplayName] = useState<string>('');
  const [template, setTemplate] = useState<string>('qwen3.5_nonthinking');
  const [contextSize, setContextSize] = useState<number>(32768);
  const [description, setDescription] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const selectGgufFile = async () => {
    try {
      const { open: openDialog } = await import('@tauri-apps/plugin-dialog');
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: 'GGUF Model', extensions: ['gguf'] }],
        title: '选择 GGUF 模型文件',
      });
      if (selected) {
        const path = Array.isArray(selected) ? selected[0] : selected;
        setGgufPath(path);
        // Auto-fill name from filename if empty
        if (!name) {
          const fileName = path.split(/[/\\]/).pop() || '';
          const base = fileName.replace(/\.gguf$/i, '').replace(/\s+/g, '-').toLowerCase();
          setName(base);
          if (!displayName) {
            setDisplayName(base.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()));
          }
        }
      }
    } catch (error) {
      console.error('Failed to open file dialog:', error);
      toast.error('无法打开文件选择对话框');
    }
  };

  const canSubmit =
    ggufPath.length > 0 && name.trim().length > 0 && displayName.trim().length > 0 && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      await invoke('builtin_ai_add_custom_model', {
        params: {
          name: name.trim(),
          displayName: displayName.trim(),
          ggufPath,
          template,
          contextSize,
          description: description.trim(),
        },
      });
      toast.success(`自定义模型已添加：${displayName.trim()}`);
      // Reset form
      setGgufPath('');
      setName('');
      setDisplayName('');
      setTemplate('qwen3.5_nonthinking');
      setContextSize(32768);
      setDescription('');
      onClose();
      onAdded();
    } catch (error) {
      console.error('Failed to add custom model:', error);
      toast.error(`添加自定义模型失败：${error}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const fileName = ggufPath.split(/[/\\]/).pop() || '';

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>添加自定义模型</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
          {/* Step 1: Select GGUF file */}
          <div className="space-y-2">
            <Label>模型文件（GGUF）*</Label>
            <div className="flex gap-2">
              <div className="flex-1 flex items-center rounded-md border border-gray-300 bg-gray-50 px-3 py-2 text-sm min-w-0">
                {ggufPath ? (
                  <span className="truncate" title={ggufPath}>
                    {fileName}
                  </span>
                ) : (
                  <span className="text-gray-400">未选择文件</span>
                )}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={selectGgufFile}>
                <FileSearch className="mr-2 h-4 w-4" />
                浏览
              </Button>
            </div>
            <p className="text-xs text-gray-500">
              支持 GGUF 格式模型文件，可从 HuggingFace 等来源下载
            </p>
          </div>

          {/* Step 2: Model name */}
          <div className="space-y-2">
            <Label>模型名称*</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：qwen3.5-35b"
            />
            <p className="text-xs text-gray-500">用于内部标识，仅允许字母、数字、-、_、.</p>
          </div>

          {/* Step 3: Display name */}
          <div className="space-y-2">
            <Label>显示名称*</Label>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="例如：Qwen 3.5 35B (自定义)"
            />
          </div>

          {/* Step 4: Template */}
          <div className="space-y-2">
            <Label>对话模板*</Label>
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-gray-800"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            >
              {TEMPLATE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500">
              {TEMPLATE_OPTIONS.find((o) => o.value === template)?.description}
            </p>
          </div>

          {/* Step 5: Context size */}
          <div className="space-y-2">
            <Label>上下文大小</Label>
            <select
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-gray-800"
              value={contextSize}
              onChange={(e) => setContextSize(Number(e.target.value))}
            >
              {CONTEXT_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size.toLocaleString()} tokens
                </option>
              ))}
            </select>
          </div>

          {/* Step 6: Description */}
          <div className="space-y-2">
            <Label>描述（可选）</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="例如：Qwen 3.5 35B Q4 量化，需要约 24GB 内存"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            添加模型
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
