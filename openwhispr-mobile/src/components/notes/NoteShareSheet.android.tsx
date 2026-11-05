import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { isCloudBackupEnabled } from '@/lib/cloudBackup';
import { noteShareMenuActions } from './noteShareMenuActions';
import { createNoteShareSheet } from './NoteShareSheetCore';

export type { NoteShareSheetProps } from './NoteShareSheetCore';
export const NoteShareSheet = createNoteShareSheet({
  useCopy: useAndroidCopy,
  cloudBackupEnabled: isCloudBackupEnabled,
  menuActions: noteShareMenuActions,
  cancelLabel: true,
  privacyFailure: {
    initial: false,
    failed: true,
    message: (failed, copy) =>
      failed ? copy('noteSharing.enableFailed', 'Unable to enable cloud sync. Try again.') : null,
  },
  headerStyle: (top) => ({ paddingTop: top + 20 }),
  headerClassName: 'min-w-0 flex-1 text-[22px] font-bold text-label',
  loadingRowClassName: 'min-w-0 flex-1 text-[15px] text-secondaryLabel',
  updatingClassName: 'min-w-0 flex-1 text-[13px] text-secondaryLabel',
  loadingClassName: 'min-w-0 flex-1 text-secondaryLabel',
});
