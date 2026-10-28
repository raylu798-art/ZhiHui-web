import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Cog, Globe, Mic } from 'lucide-react';
import { ModalType } from '@/hooks/useModalState';
import { useTranslation } from 'react-i18next';

/**
 * QuickSettingsBar Component
 *
 * Restored from meetily: top-center quick access to transcription model,
 * audio devices and language settings on the recording page.
 */

interface QuickSettingsBarProps {
  showModal: (name: ModalType, message?: string) => void;
}

export function QuickSettingsBar({ showModal }: QuickSettingsBarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex justify-center items-center pt-4 pb-2">
      <ButtonGroup>
        <Button
          variant="outline"
          size="sm"
          onClick={() => showModal('modelSelector')}
          title={t('home.model')}
        >
          <Cog />
          <span className="hidden md:inline">{t('home.model')}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => showModal('deviceSettings')}
          title={t('home.devices')}
        >
          <Mic />
          <span className="hidden md:inline">{t('home.devices')}</span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => showModal('languageSettings')}
          title={t('home.language')}
        >
          <Globe />
          <span className="hidden md:inline">{t('home.language')}</span>
        </Button>
      </ButtonGroup>
    </div>
  );
}
