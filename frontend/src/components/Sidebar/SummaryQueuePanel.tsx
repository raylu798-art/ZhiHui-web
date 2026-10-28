'use client';

import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2, X, Sparkles } from 'lucide-react';
import { useSidebar } from './SidebarProvider';

/**
 * Sidebar-bottom panel listing summary generations currently running in the
 * backend. Generation survives page navigation; this panel gives global
 * visibility plus a per-task cancel button (queue-like behavior).
 */
export function SummaryQueuePanel() {
  const { activeSummaryPolls, sidebarItems, stopSummaryPolling } = useSidebar();

  const runningIds = Array.from(activeSummaryPolls.keys());
  if (runningIds.length === 0) return null;

  const findTitle = (id: string): string => {
    for (const item of sidebarItems) {
      if (item.id === id) return item.title;
      const child = item.children?.find((c) => c.id === id);
      if (child) return child.title;
    }
    return id;
  };

  const cancel = async (id: string) => {
    try {
      await invoke('api_cancel_summary', { meetingId: id });
    } catch (e) {
      console.error('Failed to cancel summary:', e);
    }
    stopSummaryPolling(id);
  };

  return (
    <div className="border-t border-gray-200 px-3 py-2 space-y-2 bg-gray-50">
      <div className="flex items-center gap-1.5">
        <Sparkles className="h-3.5 w-3.5 text-gray-600" />
        <span className="text-xs font-semibold text-gray-700">
          摘要生成中{runningIds.length > 1 ? ` (${runningIds.length})` : ''}
        </span>
      </div>

      {runningIds.map((id) => (
        <div key={id} className="flex items-center gap-2 min-w-0">
          <Loader2 className="h-3.5 w-3.5 text-blue-600 animate-spin shrink-0" />
          <span className="text-xs text-gray-800 truncate flex-1" title={findTitle(id)}>
            {findTitle(id)}
          </span>
          <button
            className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-red-600 shrink-0"
            onClick={() => cancel(id)}
            title="取消生成"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      <p className="text-[10px] text-gray-400">切换页面不会中断生成，完成后自动保存</p>
    </div>
  );
}
