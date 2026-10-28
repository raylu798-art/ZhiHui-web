"use client";

import { RefObject, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Download, FileText, FileType2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { Summary } from '@/types';
import { BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import {
  ExportBlock, ExportDocumentData, ExportTranscriptSegment,
  formatMeetingDate, legacySummaryToBlocks, normalizeBlocks, sanitizeFileName,
} from '@/lib/export/blockUtils';
import { generatePdf } from '@/lib/export/exportPdf';
import { generateDocx } from '@/lib/export/exportDocx';
import Analytics from '@/lib/analytics';

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meeting: { id: string; title: string; created_at: string };
  aiSummary: Summary | null;
  summaryRef: RefObject<BlockNoteSummaryViewRef>;
  transcriptSource?: string | null;
}

interface ExportTranscriptsResponse {
  transcripts: Array<{ id: string; text: string; speaker?: string }>;
  total_count: number;
}

type ExportFormat = 'pdf' | 'docx';

export function ExportDialog({
  open,
  onOpenChange,
  meeting,
  aiSummary,
  summaryRef,
  transcriptSource,
}: ExportDialogProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [includeTranscript, setIncludeTranscript] = useState(true);
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      // Collect summary blocks from the live editor; legacy JSON is converted directly
      const rawBlocks = summaryRef.current?.getBlocks() ?? [];
      let blocks: ExportBlock[] = normalizeBlocks(rawBlocks as any[]);
      if (blocks.length === 0 && aiSummary) {
        blocks = legacySummaryToBlocks(aiSummary);
      }

      // The paginated hook only holds part of the transcript, so fetch everything
      let transcripts: ExportTranscriptSegment[] | null = null;
      if (includeTranscript) {
        const resp = await invoke<ExportTranscriptsResponse>('api_get_meeting_transcripts', {
          meetingId: meeting.id,
          limit: 500000,
          offset: 0,
          source: transcriptSource ?? null,
        });
        transcripts = (resp.transcripts || [])
          .filter((seg) => seg.text && seg.text.trim().length > 0)
          .map((seg) => ({ speaker: seg.speaker, text: seg.text }));
      }

      if (blocks.length === 0 && (!transcripts || transcripts.length === 0)) {
        toast.error(t('export.nothingToExport'));
        return;
      }

      const data: ExportDocumentData = {
        title: meeting.title,
        dateText: formatMeetingDate(meeting.created_at),
        blocks,
        transcripts,
        labels: { transcriptHeading: t('export.transcriptHeading') },
      };

      const bytes = format === 'pdf' ? await generatePdf(data) : await generateDocx(data);

      const path = await save({
        defaultPath: `${sanitizeFileName(meeting.title)}.${format}`,
        filters: format === 'pdf'
          ? [{ name: 'PDF', extensions: ['pdf'] }]
          : [{ name: 'Word', extensions: ['docx'] }],
      });
      if (!path) return; // user cancelled the save dialog

      await writeFile(path, bytes);
      Analytics.trackButtonClick(`export_${format}`, 'meeting_details');
      toast.success(t('export.success'), { description: path });
      onOpenChange(false);
    } catch (err) {
      console.error('Export failed:', err);
      toast.error(t('export.failed'), { description: String(err) });
    } finally {
      setIsExporting(false);
    }
  };

  const formatOption = (value: ExportFormat, icon: React.ReactNode, label: string, hint: string) => (
    <button
      type="button"
      onClick={() => setFormat(value)}
      disabled={isExporting}
      className={`flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${
        format === value
          ? 'border-blue-500 bg-blue-50'
          : 'border-gray-200 hover:border-gray-300 bg-white'
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-medium text-gray-800">
        {icon}
        {label}
      </span>
      <span className="text-xs text-gray-500">{hint}</span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!isExporting) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('export.title')}</DialogTitle>
          <DialogDescription>{t('export.description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div>
            <div className="text-sm font-medium mb-2">{t('export.format')}</div>
            <div className="grid grid-cols-2 gap-2">
              {formatOption('pdf', <FileText size={16} className="text-red-500" />, 'PDF', t('export.pdfHint'))}
              {formatOption('docx', <FileType2 size={16} className="text-blue-600" />, 'Word (DOCX)', t('export.docxHint'))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeTranscript}
              onChange={(e) => setIncludeTranscript(e.target.checked)}
              disabled={isExporting}
              className="rounded border-gray-300"
            />
            {t('export.includeTranscript')}
            <span className="text-xs text-gray-400">{t('export.transcriptNote')}</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={isExporting}>
            {t('export.cancel')}
          </Button>
          <Button size="sm" onClick={handleExport} disabled={isExporting}>
            {isExporting ? (
              <>
                <Loader2 className="animate-spin" />
                {t('export.exporting')}
              </>
            ) : (
              <>
                <Download />
                {t('export.export')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
