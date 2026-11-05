import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { createFolderRow } from './FolderRowCore';

export const FolderRow = createFolderRow(function useFolderRowPresentation(count) {
  const { copy } = useAndroidCopy();
  return {
    countLabel: copy('library.noteCount', `${count} ${count === 1 ? 'note' : 'notes'}`, { count }),
    rowClassName: 'flex-row items-center justify-between gap-3',
    labelClassName: 'min-w-0 flex-1 text-[17px] font-medium text-label',
    labelLines: 2,
  };
});
