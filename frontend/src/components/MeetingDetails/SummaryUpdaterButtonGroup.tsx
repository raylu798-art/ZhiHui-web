"use client";

import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, Save, Loader2, Search, FolderOpen, Download } from 'lucide-react';
import Analytics from '@/lib/analytics';
import { useTranslation } from 'react-i18next';

interface SummaryUpdaterButtonGroupProps {
  isSaving: boolean;
  isDirty: boolean;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
  onFind?: () => void;
  onOpenFolder: () => Promise<void>;
  hasSummary: boolean;
  onExport?: () => void;
}

export function SummaryUpdaterButtonGroup({
  isSaving,
  isDirty,
  onSave,
  onCopy,
  onFind,
  onOpenFolder,
  hasSummary,
  onExport
}: SummaryUpdaterButtonGroupProps) {
  const { t } = useTranslation();
  return (
    <ButtonGroup>
      {/* Save button */}
      <Button
        variant="outline"
        size="sm"
        className={`${isDirty ? 'bg-green-200' : ""}`}
        title={isSaving ? t('meetingButtons.saving') : t('meetingButtons.saveChanges')}
        onClick={() => {
          Analytics.trackButtonClick('save_changes', 'meeting_details');
          onSave();
        }}
        disabled={isSaving}
      >
        {isSaving ? (
          <>
            <Loader2 className="animate-spin" />
            <span className="hidden lg:inline">{t('meetingButtons.savingEllipsis')}</span>
          </>
        ) : (
          <>
            <Save />
            <span className="hidden lg:inline">{t('meetingButtons.save')}</span>
          </>
        )}
      </Button>

      {/* Copy button */}
      <Button
        variant="outline"
        size="sm"
        title={t('meetingButtons.copySummary')}
        onClick={() => {
          Analytics.trackButtonClick('copy_summary', 'meeting_details');
          onCopy();
        }}
        disabled={!hasSummary}
        className="cursor-pointer"
      >
        <Copy />
        <span className="hidden lg:inline">{t('meetingButtons.copy')}</span>
      </Button>

      {/* Export button */}
      {onExport && (
        <Button
          variant="outline"
          size="sm"
          title={t('export.title')}
          onClick={() => {
            Analytics.trackButtonClick('open_export_dialog', 'meeting_details');
            onExport();
          }}
          className="cursor-pointer"
        >
          <Download />
          <span className="hidden lg:inline">{t('export.button')}</span>
        </Button>
      )}

      {/* Find button */}
      {/* {onFind && (
        <Button
          variant="outline"
          size="sm"
          title="Find in Summary"
          onClick={() => {
            Analytics.trackButtonClick('find_in_summary', 'meeting_details');
            onFind();
          }}
          disabled={!hasSummary}
          className="cursor-pointer"
        >
          <Search />
          <span className="hidden lg:inline">Find</span>
        </Button>
      )} */}
    </ButtonGroup>
  );
}
