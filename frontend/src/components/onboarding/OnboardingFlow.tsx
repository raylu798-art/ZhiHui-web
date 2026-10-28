import React, { useEffect } from 'react';
import { useOnboarding } from '@/contexts/OnboardingContext';
import {
  WelcomeStep,
  PermissionsStep,
  DownloadProgressStep,
  SetupOverviewStep,
  OfflineImportStep,
} from './steps';

interface OnboardingFlowProps {
  onComplete: () => void;
}

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { currentStep, installMode } = useOnboarding();
  const [isMac, setIsMac] = React.useState(false);

  useEffect(() => {
    // Check if running on macOS
    const checkPlatform = async () => {
      try {
        // Dynamic import to avoid SSR issues if any
        const { platform } = await import('@tauri-apps/plugin-os');
        setIsMac(platform() === 'macos');
      } catch (e) {
        console.error('Failed to detect platform:', e);
        // Fallback
        setIsMac(navigator.userAgent.includes('Mac'));
      }
    };
    checkPlatform();
  }, []);

  // 4-Step Onboarding Flow (System-Recommended Models):
  // Step 1: Welcome - Introduce Meetily features
  // Step 2: Setup Overview - Database initialization + show recommended downloads
  // Step 3: Download Progress - Download SenseVoice + Summary Model (SenseVoice + Qwen3.5-2B to match the offline preset)
  //         or, when the user picked the offline path, import the models from a local folder
  // Step 4: Permissions - Request mic + system audio (macOS only)

  return (
    <div className="onboarding-flow">
      {currentStep === 1 && <WelcomeStep />}
      {currentStep === 2 && <SetupOverviewStep />}
      {currentStep === 3 &&
        (installMode === 'offline' ? <OfflineImportStep /> : <DownloadProgressStep />)}
      {currentStep === 4 && isMac && <PermissionsStep />}
    </div>
  );
}
