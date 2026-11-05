import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { formatLibraryTime } from '@/android/libraryTime';
import { createSyncStatusLabel } from './SyncStatusLabelCore';

export const SyncStatusLabel = createSyncStatusLabel(function useStatusPresentation() {
  const { copy, language } = useAndroidCopy();
  return {
    copy,
    formatTime: (timestamp) => formatLibraryTime(timestamp, language),
    accessibilityLabel: ({ label, canTapToSync, isGated, conflictLabel }) =>
      [
        copy('syncStatus', `Sync status: ${label}`, { status: label }),
        canTapToSync ? copy('library.syncTap', 'Tap to sync now.') : '',
        isGated ? copy('library.upgradeTap', 'Tap to upgrade.') : '',
        conflictLabel,
      ]
        .filter(Boolean)
        .join(' '),
    unlimitedLines: true,
    conflictClassName: 'shrink text-[13px] font-medium text-systemOrange',
  };
});
