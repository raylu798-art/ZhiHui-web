'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, KeyRound, Monitor } from 'lucide-react';
import { toast } from 'sonner';
import { useLicense } from '@/contexts/LicenseContext';

/**
 * License settings panel (settings page "license" tab):
 * status card, activation input, device info,
 * and an advanced server URL configuration.
 * Online verification runs automatically in the background; self-service
 * unbind is intentionally not offered (keys keep their original expiry).
 */
export function LicenseSettings() {
  const { license, activate } = useLicense();
  const [key, setKey] = useState('');
  const [activating, setActivating] = useState(false);

  const handleActivate = async () => {
    const trimmed = key.trim();
    if (!trimmed) {
      toast.error('请输入 License Key');
      return;
    }
    setActivating(true);
    try {
      const result = await activate(trimmed);
      toast.success(
        result.status === 'active'
          ? `激活成功，有效期至 ${result.expires_at?.slice(0, 10)}`
          : '激活完成，但状态异常，请检查'
      );
      setKey('');
    } catch (e: any) {
      const msg = typeof e === 'string' ? e : e?.message || '激活失败';
      toast.error(`激活失败：${msg}`);
    } finally {
      setActivating(false);
    }
  };

  const statusCard = () => {
    if (!license) {
      return <p className="text-sm text-gray-500">正在加载授权状态...</p>;
    }
    switch (license.status) {
      case 'trial':
        return (
          <div className="rounded-lg bg-yellow-50 border border-yellow-200 p-4">
            <p className="text-sm font-medium text-yellow-800">
              试用中 — 剩余 {license.days_remaining} 天（共 {license.trial_days_total} 天）
            </p>
            <p className="text-xs text-yellow-700 mt-1">
              试用期结束后可输入 License Key 激活正式授权
            </p>
          </div>
        );
      case 'active':
        return (
          <div className="rounded-lg bg-green-50 border border-green-200 p-4">
            <p className="text-sm font-medium text-green-800">
              已授权 — 有效期至 {license.expires_at?.slice(0, 10)}（剩余 {license.days_remaining} 天）
            </p>
            <p className="text-xs text-green-700 mt-1">License：{license.license_key_masked}</p>
          </div>
        );
      case 'expired':
        return (
          <div className="rounded-lg bg-red-50 border border-red-200 p-4">
            <p className="text-sm font-medium text-red-800">
              {license.reason === 'trial_expired'
                ? '试用期已结束'
                : license.reason === 'clock_rollback'
                  ? '系统时钟异常（请校准时钟）'
                  : '授权已到期'}
              ，当前为只读模式
            </p>
            <p className="text-xs text-red-700 mt-1">
              可查看/导出历史记录；输入新的 License Key 可恢复完整功能
            </p>
          </div>
        );
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-2">
        <KeyRound className="h-5 w-5 text-gray-600" />
        <h3 className="text-lg font-semibold">软件授权</h3>
      </div>

      {statusCard()}

      {/* Activation */}
      <div className="border rounded-lg p-4 space-y-3">
        <label className="text-sm font-medium text-gray-700">激活 License</label>
        <div className="flex gap-2">
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            placeholder="ZHUI-XXXX-XXXX-XXXX-XXXX"
            style={{ fontFamily: 'monospace' }}
          />
          <Button onClick={handleActivate} disabled={activating || !key.trim()}>
            {activating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            激活
          </Button>
        </div>
        <p className="text-xs text-gray-500">激活需要联网验证一次；成功后可完全离线使用至授权到期</p>
      </div>

      {/* Device info (device name only; fingerprint is internal) */}
      <div className="border rounded-lg p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Monitor className="h-4 w-4 text-gray-500" />
          <span className="text-sm font-medium text-gray-700">设备信息</span>
        </div>
        <div className="text-sm text-gray-600 space-y-1">
          <p>设备名：{license?.device_name || '-'}</p>
        </div>
      </div>
    </div>
  );
}
