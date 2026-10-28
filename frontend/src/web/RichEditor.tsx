'use client';
import { useEffect, useRef } from 'react';
import type { Block } from '@blocknote/core';
import { zh } from '@blocknote/core/locales';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/shadcn';
import '@blocknote/shadcn/style.css';

export default function RichEditor({ value, onChange, onError }: { value: string; onChange: (markdown: string, blocks: Block[], dirty: boolean) => void; onError: (message: string) => void }) {
  const editor = useCreateBlockNote({ dictionary: zh });
  const loading = useRef(true); const generation = useRef(0); const latest = useRef(onChange); const errors = useRef(onError);
  useEffect(() => { latest.current = onChange; errors.current = onError; }, [onChange, onError]);
  useEffect(() => {
    let cancelled = false; loading.current = true; generation.current++;
    void editor.tryParseMarkdownToBlocks(value).then(async blocks => {
      if (cancelled) return;
      editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph' }]);
      const markdown = await editor.blocksToMarkdownLossy(editor.document);
      if (!cancelled) { latest.current(markdown, editor.document, false); loading.current = false; }
    }).catch(error => { if (!cancelled) errors.current(error instanceof Error ? error.message : '纪要编辑器初始化失败'); });
    return () => { cancelled = true; };
  }, [editor, value]);
  useEffect(() => editor.onChange(() => {
    if (loading.current) return;
    const revision = ++generation.current;
    void editor.blocksToMarkdownLossy(editor.document).then(markdown => { if (revision === generation.current) latest.current(markdown, editor.document, true); }).catch(error => errors.current(error instanceof Error ? error.message : '纪要编辑失败'));
  }), [editor]);
  return <BlockNoteView editor={editor} theme="light" className="summary-editor" />;
}
