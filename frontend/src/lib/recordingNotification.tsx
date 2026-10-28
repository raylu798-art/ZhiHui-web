import { toast } from 'sonner';
import Analytics from '@/lib/analytics';
import i18n from '@/lib/i18n/config';

/**
 * Shows the recording notification toast with compliance message.
 * Checks user preferences and displays a dismissible toast with:
 * - notice to inform participants
 * - "Don't show again" checkbox
 * - Acknowledgment button
 *
 * @returns Promise<void> - Resolves when notification is shown or skipped
 */
export async function showRecordingNotification(): Promise<void> {
  try {
    // Respect the General > Notifications switch (notification_preferences).
    // When the user disabled notifications, skip the recording-start popup.
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const settings = await invoke<{ notification_preferences?: { show_recording_started?: boolean } }>('get_notification_settings');
      if (settings?.notification_preferences?.show_recording_started === false) {
        return;
      }
    } catch (settingsError) {
      // Notification manager not initialized: notifications default to ON.
      console.warn('Notification settings unavailable, defaulting to show:', settingsError);
    }

    const { Store } = await import('@tauri-apps/plugin-store');
    const store = await Store.load('preferences.json');
    const showNotification = await store.get<boolean>('show_recording_notification') ?? true;

    if (showNotification) {
      let dontShowAgain = false;

      const toastId = toast.info(i18n.t('recordingNotification.title'), {
        description: (
          <div className="space-y-3 min-w-[280px]">
            <p className="text-sm font-medium text-gray-900">
              {i18n.t('recordingNotification.message')}
            </p>
            <label className="flex items-center gap-2 text-xs cursor-pointer hover:bg-blue-100 p-2 rounded transition-colors">
              <input
                type="checkbox"
                onChange={(e) => {
                  dontShowAgain = e.target.checked;
                }}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 focus:ring-2"
              />
              <span className="select-none text-gray-700">{i18n.t('recordingNotification.dontShowAgain')}</span>
            </label>
            <button
              onClick={async () => {
                if (dontShowAgain) {
                  const { Store } = await import('@tauri-apps/plugin-store');
                  const store = await Store.load('preferences.json');
                  await store.set('show_recording_notification', false);
                  await store.save();
                }
                Analytics.trackButtonClick('recording_notification_acknowledged', 'toast');
                toast.dismiss(toastId);
              }}
              className="w-full px-3 py-1.5 bg-gray-900 text-white text-xs rounded hover:bg-gray-800 transition-colors font-medium"
            >
              {i18n.t('recordingNotification.acknowledged')}
            </button>
          </div>
        ),
        duration: 10000,
        position: 'bottom-right',
      });
    }
  } catch (notificationError) {
    console.error('Failed to show recording notification:', notificationError);
    // Don't fail the recording if notification fails
  }
}
