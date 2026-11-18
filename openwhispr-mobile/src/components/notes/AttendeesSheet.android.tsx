import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { attendeeName } from '@/lib/notes/noteMeta.android';
import { createAttendeesSheet } from './AttendeesSheetCore.android';

export const AttendeesSheet = createAttendeesSheet(function useAttendeesPresentation() {
  const { copy } = useAndroidCopy();
  return {
    copy,
    name: (participant) =>
      attendeeName(participant, {
        you: copy('noteDetails.you', 'You'),
        guest: copy('noteDetails.guest', 'Guest'),
      }),
    headerStyle: (top) => ({ paddingTop: top + 20 }),
    headerClassName: 'flex-1 pr-4 text-[22px] font-bold text-label',
    personClassName: 'gap-1',
  };
});
