import { useTranslation } from 'react-i18next';
import { iosColor } from '@/config/colors';
import { createNewFolderSheet, type NewFolderPresentation } from './NewFolderSheetCore.android';

function useAndroidFolderPresentation(initialName?: string): NewFolderPresentation {
  const { t } = useTranslation('android');
  return {
    initialName,
    title: t(initialName === undefined ? 'newFolder' : 'renameFolder'),
    submitLabel: t(initialName === undefined ? 'createFolder' : 'save'),
    placeholder: t('folderName'),
    placeholderTextColor: iosColor('tertiaryLabel'),
    backgroundColor: iosColor('tertiarySystemFill'),
  };
}

export const NewFolderSheet = createNewFolderSheet(useAndroidFolderPresentation);
