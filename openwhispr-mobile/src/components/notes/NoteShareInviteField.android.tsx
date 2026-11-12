import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { usePrincipalLabels } from './NoteSharePrincipal.android';
import { createNoteShareInviteField } from './NoteShareInviteFieldCore.android';

export const NoteShareInviteField = createNoteShareInviteField({
  useCopy: useAndroidCopy,
  useLabels: usePrincipalLabels,
  inputClassName: 'min-h-[48px] py-1 text-[15px] text-label',
  numberOfLines: undefined,
  inviteText: (query, copy) => copy('noteAccess.invite', `Invite ${query}`, { email: query }),
});
