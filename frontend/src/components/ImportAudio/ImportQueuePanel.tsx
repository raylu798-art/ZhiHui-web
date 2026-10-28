'use client';

import { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { Loader2, X, FileAudio, FileText, CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSidebar } from '../Sidebar/SidebarProvider';
import { useTranslation } from 'react-i18next';
import { localizeBackendError } from '@/lib/errorMessages';

interface TaskSummary {
  id: string;
  title: string;
  kind: 'audio' | 'text';
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  meeting_id: string | null;
  error: string | null;
}

interface QueueSnapshot {
  current: TaskSummary | null;
  queued: TaskSummary[];
  recent: TaskSummary[];
}

interface ProgressPayload {
  task_id?: string | null;
  stage: string;
  progress_percentage: number;
}

/**
 * Sidebar-bottom panel showing the background import queue:
 * the running task with live progress plus queued tasks with cancel buttons.
 * Hidden entirely when there is nothing queued or running.
 */
export function ImportQueuePanel() {
  const { refetchMeetings } = useSidebar();
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});

  const refresh = useCallback(async () => {
    try {
      const state = await invoke<QueueSnapshot>('import_queue_get_state');
      setSnapshot(state);
    } catch (e) {
      console.error('Failed to fetch import queue state:', e);
    }
  }, []);

  useEffect(() => {
    refresh();

    const unlisteners: UnlistenFn[] = [];
    let disposed = false;

    const setup = async () => {
      const u1 = await listen<QueueSnapshot>('import-queue-updated', (event) => {
        setSnapshot(event.payload);
        // Refresh meetings when a task completes so the new meeting appears
        const completed = event.payload.recent?.[0];
        if (completed && completed.status === 'complete') {
          refetchMeetings();
        }
      });
      const u2 = await listen<ProgressPayload>('import-progress', (event) => {
        const taskId = event.payload.task_id;
        if (!taskId) return;
        setProgress((prev) => ({ ...prev, [taskId]: event.payload.progress_percentage }));
      });
      if (disposed) {
        u1();
        u2();
        return;
      }
      unlisteners.push(u1, u2);
    };

    setup();

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
  }, [refresh, refetchMeetings]);

  const cancelTask = async (taskId: string) => {
    try {
      await invoke('import_queue_cancel_task', { taskId });
      refresh();
    } catch (e) {
      console.error('Failed to cancel task:', e);
    }
  };

  if (!snapshot) return null;

  const { current, queued } = snapshot;
  // Hide when idle
  if (!current && queued.length === 0) return null;

  const currentProgress = current ? progress[current.id] : undefined;

  return (
    <div className="border-t border-gray-200 px-3 py-2 space-y-2 bg-gray-50">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-700">
          导入队列{queued.length > 0 ? ` (${queued.length + (current ? 1 : 0)})` : ''}
        </span>
      </div>

      {/* Running task */}
      {current && (
        <div className="space-y-1">
          <div className="flex items-center gap-2 min-w-0">
            {current.kind === 'audio' ? (
              <FileAudio className="h-3.5 w-3.5 text-blue-600 shrink-0" />
            ) : (
              <FileText className="h-3.5 w-3.5 text-blue-600 shrink-0" />
            )}
            <span className="text-xs text-gray-800 truncate flex-1" title={current.title}>
              {current.title}
            </span>
            <Loader2 className="h-3 w-3 animate-spin text-blue-600 shrink-0" />
          </div>
          <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-600 rounded-full transition-all duration-300"
              style={{ width: `${Math.min(currentProgress ?? 0, 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Queued tasks */}
      {queued.map((task) => (
        <div key={task.id} className="flex items-center gap-2 min-w-0">
          {task.kind === 'audio' ? (
            <FileAudio className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          ) : (
            <FileText className="h-3.5 w-3.5 text-gray-400 shrink-0" />
          )}
          <span className="text-xs text-gray-500 truncate flex-1" title={task.title}>
            {task.title}
          </span>
          <span className="text-[10px] text-gray-400 shrink-0">排队中</span>
          <button
            className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-red-600 shrink-0"
            onClick={() => cancelTask(task.id)}
            title="取消"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}

      {/* Recent result hint (only the most recent failure, briefly) */}
      {snapshot.recent?.[0]?.status === 'failed' && !current && queued.length === 0 && (
        <div className="flex items-center gap-1.5 text-xs text-red-600">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate" title={localizeBackendError(snapshot.recent[0].error, t)}>
            导入失败：{snapshot.recent[0].title}
          </span>
        </div>
      )}
      {snapshot.recent?.[0]?.status === 'complete' && !current && queued.length === 0 && (
        <div className={cn('flex items-center gap-1.5 text-xs text-green-600')}>
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">导入完成：{snapshot.recent[0].title}</span>
        </div>
      )}
    </div>
  );
}
