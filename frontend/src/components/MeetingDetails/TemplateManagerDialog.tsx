"use client";

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import {
  Loader2,
  Plus,
  Pencil,
  Copy,
  Trash2,
  RotateCcw,
  ArrowUp,
  ArrowDown,
  X,
  ChevronLeft,
} from 'lucide-react';

interface TemplateListItem {
  id: string;
  name: string;
  description: string;
}

interface FullTemplateSection {
  title: string;
  instruction: string;
  format: string;
  item_format?: string;
}

interface FullTemplate {
  id: string;
  is_custom: boolean;
  template: {
    name: string;
    description: string;
    sections: FullTemplateSection[];
  };
}

interface EditorSection {
  title: string;
  instruction: string;
  format: 'paragraph' | 'list';
  itemFormat: string;
}

interface EditorState {
  /** Existing custom id to overwrite; null saves as a new custom template */
  targetId: string | null;
  mode: 'new' | 'edit' | 'copy';
  /** Editing a built-in template: saving creates a custom override */
  isOverride: boolean;
  name: string;
  description: string;
  sections: EditorSection[];
}

interface TemplateManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: TemplateListItem[];
  onTemplatesChanged: () => void;
}

const emptySection = (): EditorSection => ({
  title: '',
  instruction: '',
  format: 'paragraph',
  itemFormat: '',
});

export function TemplateManagerDialog({
  open,
  onOpenChange,
  templates,
  onTemplatesChanged,
}: TemplateManagerDialogProps) {
  const { t } = useTranslation();
  const [customIds, setCustomIds] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Resolve which list entries live in the custom directory each time the
  // dialog opens (the list itself has no origin information)
  useEffect(() => {
    if (!open) {
      setEditor(null);
      setDeleteConfirmId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const ids = new Set<string>();
      await Promise.all(
        templates.map(async (tpl) => {
          try {
            const full = await invoke<FullTemplate>('api_get_template_full', {
              templateId: tpl.id,
            });
            if (full.is_custom) ids.add(tpl.id);
          } catch {
            // Unreadable template: treat as bundled (read-only)
          }
        })
      );
      if (!cancelled) setCustomIds(ids);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, templates]);

  const openEditor = useCallback(
    async (tpl: TemplateListItem | null, mode: 'new' | 'edit' | 'copy') => {
      if (!tpl) {
        setEditor({
          targetId: null,
          mode: 'new',
          isOverride: false,
          name: '',
          description: '',
          sections: [emptySection()],
        });
        return;
      }
      try {
        const full = await invoke<FullTemplate>('api_get_template_full', {
          templateId: tpl.id,
        });
        setEditor({
          targetId: mode === 'edit' ? full.id : null,
          mode,
          isOverride: mode === 'edit' && !full.is_custom,
          name:
            mode === 'copy'
              ? `${full.template.name}${t('templateManager.copySuffix')}`
              : full.template.name,
          description: full.template.description,
          sections: full.template.sections.map((s) => ({
            title: s.title,
            instruction: s.instruction,
            format: s.format === 'list' ? 'list' : 'paragraph',
            itemFormat: s.item_format || '',
          })),
        });
      } catch (err) {
        toast.error(t('templateManager.loadFailed'), { description: String(err) });
      }
    },
    [t]
  );

  const updateSection = (index: number, patch: Partial<EditorSection>) => {
    setEditor((prev) =>
      prev
        ? {
            ...prev,
            sections: prev.sections.map((s, i) => (i === index ? { ...s, ...patch } : s)),
          }
        : prev
    );
  };

  const moveSection = (index: number, delta: -1 | 1) => {
    setEditor((prev) => {
      if (!prev) return prev;
      const target = index + delta;
      if (target < 0 || target >= prev.sections.length) return prev;
      const sections = [...prev.sections];
      [sections[index], sections[target]] = [sections[target], sections[index]];
      return { ...prev, sections };
    });
  };

  const removeSection = (index: number) => {
    setEditor((prev) =>
      prev ? { ...prev, sections: prev.sections.filter((_, i) => i !== index) } : prev
    );
  };

  const handleSave = async () => {
    if (!editor) return;
    const name = editor.name.trim();
    const description = editor.description.trim();
    if (!name) {
      toast.error(t('templateManager.nameRequired'));
      return;
    }
    if (editor.sections.length === 0) {
      toast.error(t('templateManager.sectionRequired'));
      return;
    }
    if (editor.sections.some((s) => !s.title.trim() || !s.instruction.trim())) {
      toast.error(t('templateManager.sectionIncomplete'));
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        name,
        // Backend validation rejects empty descriptions, fall back to the name
        description: description || name,
        sections: editor.sections.map((s) => ({
          title: s.title.trim(),
          instruction: s.instruction.trim(),
          format: s.format,
          ...(s.format === 'list' && s.itemFormat.trim()
            ? { item_format: s.itemFormat.trim() }
            : {}),
        })),
      };
      const templateId = editor.targetId ?? `custom_${Date.now()}`;
      await invoke('api_save_custom_template', {
        templateId,
        templateJson: JSON.stringify(payload, null, 2),
      });
      toast.success(t('templateManager.saved'), { description: name });
      onTemplatesChanged();
      setEditor(null);
      setCustomIds((prev) => new Set(prev).add(templateId));
    } catch (err) {
      toast.error(t('templateManager.saveFailed'), { description: String(err) });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirmId !== id) {
      setDeleteConfirmId(id);
      return;
    }
    setDeleteConfirmId(null);
    // Custom ids are generated with a custom_ prefix; anything else is an
    // override of a built-in template, deleting it restores the original
    const isRestore = !id.startsWith('custom_');
    try {
      await invoke('api_delete_custom_template', { templateId: id });
      toast.success(
        isRestore ? t('templateManager.restored') : t('templateManager.deleted')
      );
      onTemplatesChanged();
      setCustomIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch (err) {
      toast.error(t('templateManager.deleteFailed'), { description: String(err) });
    }
  };

  const editorHeading =
    editor?.mode === 'edit'
      ? t('templateManager.editorTitleEdit')
      : editor?.mode === 'copy'
        ? t('templateManager.editorTitleCopy')
        : t('templateManager.editorTitleNew');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {editor ? editorHeading : t('templateManager.title')}
          </DialogTitle>
          <DialogDescription>
            {editor
              ? editor.isOverride
                ? t('templateManager.overrideHint')
                : t('templateManager.editorDescription')
              : t('templateManager.description')}
          </DialogDescription>
        </DialogHeader>

        {!editor ? (
          <>
            <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-2">
              {templates.map((tpl) => {
                const isCustom = customIds.has(tpl.id);
                const isOverride = isCustom && !tpl.id.startsWith('custom_');
                return (
                  <div
                    key={tpl.id}
                    className="flex items-center gap-3 rounded-lg border border-gray-200 px-3 py-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{tpl.name}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${
                            isCustom
                              ? 'bg-blue-100 text-blue-700'
                              : 'bg-gray-100 text-gray-500'
                          }`}
                        >
                          {isCustom
                            ? t('templateManager.customBadge')
                            : t('templateManager.builtinBadge')}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 truncate">{tpl.description}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        title={t('templateManager.edit')}
                        onClick={() => openEditor(tpl, 'edit')}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        title={t('templateManager.duplicate')}
                        onClick={() => openEditor(tpl, 'copy')}
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      {isCustom ? (
                        deleteConfirmId === tpl.id ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            className="text-xs"
                            onClick={() => handleDelete(tpl.id)}
                          >
                            {isOverride
                              ? t('templateManager.confirmRestore')
                              : t('templateManager.confirmDelete')}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            title={
                              isOverride
                                ? t('templateManager.restore')
                                : t('templateManager.delete')
                            }
                            onClick={() => handleDelete(tpl.id)}
                          >
                            {isOverride ? (
                              <RotateCcw className="h-4 w-4 text-amber-600" />
                            ) : (
                              <Trash2 className="h-4 w-4 text-red-500" />
                            )}
                          </Button>
                        )
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between pt-2 border-t">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('templateManager.close')}
              </Button>
              <Button onClick={() => openEditor(null, 'new')}>
                <Plus className="h-4 w-4 mr-1" />
                {t('templateManager.newTemplate')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-4">
              <div className="space-y-1">
                <label className="text-sm font-medium">
                  {t('templateManager.nameLabel')}
                </label>
                <Input
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  placeholder={t('templateManager.namePlaceholder')}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">
                  {t('templateManager.descLabel')}
                </label>
                <Input
                  value={editor.description}
                  onChange={(e) => setEditor({ ...editor, description: e.target.value })}
                  placeholder={t('templateManager.descPlaceholder')}
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">
                  {t('templateManager.sectionsLabel')}
                </label>
                {editor.sections.map((section, index) => (
                  <div
                    key={index}
                    className="rounded-lg border border-gray-200 p-3 space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        className="flex-1"
                        value={section.title}
                        onChange={(e) => updateSection(index, { title: e.target.value })}
                        placeholder={t('templateManager.sectionTitle')}
                      />
                      <select
                        className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
                        value={section.format}
                        onChange={(e) =>
                          updateSection(index, {
                            format: e.target.value === 'list' ? 'list' : 'paragraph',
                          })
                        }
                      >
                        <option value="paragraph">
                          {t('templateManager.formatParagraph')}
                        </option>
                        <option value="list">{t('templateManager.formatList')}</option>
                      </select>
                      <div className="flex items-center shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={index === 0}
                          title={t('templateManager.moveUp')}
                          onClick={() => moveSection(index, -1)}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={index === editor.sections.length - 1}
                          title={t('templateManager.moveDown')}
                          onClick={() => moveSection(index, 1)}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={editor.sections.length <= 1}
                          title={t('templateManager.removeSection')}
                          onClick={() => removeSection(index)}
                        >
                          <X className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    </div>
                    <Textarea
                      value={section.instruction}
                      onChange={(e) =>
                        updateSection(index, { instruction: e.target.value })
                      }
                      placeholder={t('templateManager.sectionInstructionPlaceholder')}
                      rows={2}
                    />
                    {section.format === 'list' && (
                      <Input
                        value={section.itemFormat}
                        onChange={(e) =>
                          updateSection(index, { itemFormat: e.target.value })
                        }
                        placeholder={t('templateManager.itemFormatPlaceholder')}
                      />
                    )}
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setEditor({ ...editor, sections: [...editor.sections, emptySection()] })
                  }
                >
                  <Plus className="h-4 w-4 mr-1" />
                  {t('templateManager.addSection')}
                </Button>
              </div>
            </div>
            <div className="flex justify-between pt-2 border-t">
              <Button variant="outline" onClick={() => setEditor(null)} disabled={isSaving}>
                <ChevronLeft className="h-4 w-4 mr-1" />
                {t('templateManager.back')}
              </Button>
              <Button onClick={handleSave} disabled={isSaving}>
                {isSaving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                {isSaving ? t('templateManager.saving') : t('templateManager.save')}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
