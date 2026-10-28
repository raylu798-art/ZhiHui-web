'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Clock, KeyRound } from 'lucide-react';
import { useLicense } from '@/contexts/LicenseContext';
import { cn } from '@/lib/utils';

/**
 * Global license banner:
 * - trial: yellow, shows days remaining
 * - active & <7 days: orange, renewal hint
 * - expired: red, click to open the License settings tab
 * Hidden for active licenses with plenty of time left.
 */
export function LicenseBanner() {
  const { license } = useLicense();
  const router = useRouter();

  if (!license) return null;

  const goToLicenseSettings = () => {
    if (window.location.pathname.startsWith('/settings')) {
      // Same-route navigation would not re-run the page's mount effect;
      // ask the settings page to switch tabs directly.
      window.dispatchEvent(new CustomEvent('zhihui:open-settings-tab', { detail: 'license' }));
    } else {
      router.push('/settings?tab=license');
    }
  };

  if (license.status === 'trial') {
    const days = license.days_remaining ?? 0;
    return (
      <div className="flex items-center justify-center gap-2 bg-yellow-50 border-b border-yellow-200 px-4 py-1.5 text-xs text-yellow-800">
        <Clock className="h-3.5 w-3.5" />
        <span>
          试用剩余 <b>{days}</b> 天（共 {license.trial_days_total ?? 5} 天），到期后需激活 License
        </span>
        <button
          onClick={goToLicenseSettings}
          className="ml-2 underline hover:text-yellow-900"
        >
          立即激活
        </button>
      </div>
    );
  }

  if (license.status === 'active') {
    const days = license.days_remaining ?? 999;
    if (days > 7) return null;
    return (
      <div className="flex items-center justify-center gap-2 bg-orange-50 border-b border-orange-200 px-4 py-1.5 text-xs text-orange-800">
        <AlertTriangle className="h-3.5 w-3.5" />
        <span>
          授权将于 <b>{days}</b> 天后到期（{license.license_key_masked}），请联系管理员续期
        </span>
      </div>
    );
  }

  // expired
  const reasonText =
    license.reason === 'trial_expired'
      ? '试用期已结束'
      : license.reason === 'clock_rollback'
        ? '系统时钟异常，请校准时钟'
        : '授权已到期';

  return (
    <div
      className={cn(
        'flex items-center justify-center gap-2 bg-red-50 border-b border-red-200 px-4 py-1.5 text-xs text-red-800 cursor-pointer hover:bg-red-100'
      )}
      onClick={goToLicenseSettings}
    >
      <KeyRound className="h-3.5 w-3.5" />
      <span>
        {reasonText}，当前为只读模式（可查看/导出历史，不能录制/导入）— 点击激活 License
      </span>
    </div>
  );
}
