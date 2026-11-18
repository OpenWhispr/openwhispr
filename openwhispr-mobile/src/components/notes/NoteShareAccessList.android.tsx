import { View } from 'react-native';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { usePrincipalLabels } from './NoteSharePrincipal.android';
import { noteShareMenuActions } from './noteShareMenuActions.android';
import { createNoteShareAccessList } from './NoteShareAccessListCore.android';

export const NoteShareAccessList = createNoteShareAccessList({
  useCopy: useAndroidCopy,
  useLabels: usePrincipalLabels,
  menuActions: noteShareMenuActions,
  cancelLabel: true,
  roleButtonClassName: 'min-h-[48px] flex-row items-center gap-1 pl-2 active:opacity-60',
  personRowClassName: 'min-w-0 gap-2',
  personNameClassName: 'min-w-0',
  numberOfLines: undefined,
  wrapTrailing: (trailing) => <View className="max-w-full self-start">{trailing}</View>,
});
