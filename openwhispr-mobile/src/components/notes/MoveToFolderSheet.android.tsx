import { useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { Button } from '@/components/ui/Button';
import {
  createMoveToFolderSheet,
  type MoveFolderPresentation,
  type MoveFolderPresentationProps,
} from './MoveToFolderSheetCore.android';

export type { MoveToFolderSheetProps } from './MoveToFolderSheetCore.android';

function useAndroidMoveFolderPresentation({
  visible,
  onClose,
  onCreateAndPick,
}: MoveFolderPresentationProps): MoveFolderPresentation {
  const { t } = useTranslation('android');
  const { copy } = useAndroidCopy();
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState('');
  useEffect(() => {
    if (!visible) {
      setCreating(false);
      setFolderName('');
    }
  }, [visible]);

  return {
    copy,
    onCreate: () => setCreating(true),
    onRequestClose: () => {
      if (creating) setCreating(false);
      else onClose();
    },
    headerProps: (topInset) => ({ style: { paddingTop: topInset + 20 } }),
    titleClassName: 'min-w-0 flex-1 text-[22px] font-bold text-label',
    renderCreation: creating
      ? () => (
          <View className="gap-4">
            <TextInput
              autoFocus
              value={folderName}
              onChangeText={setFolderName}
              accessibilityLabel={t('folderName')}
              placeholder={t('folderName')}
              className="min-h-12 rounded-xl bg-tertiarySystemFill px-4 text-base text-label"
            />
            <Button
              disabled={!folderName.trim()}
              onPress={() => {
                if (!folderName.trim()) return;
                onCreateAndPick(folderName.trim());
                setCreating(false);
              }}
            >
              {t('createFolder')}
            </Button>
            <Button variant="secondary" onPress={() => setCreating(false)}>
              {t('cancel')}
            </Button>
          </View>
        )
      : undefined,
  };
}

export const MoveToFolderSheet = createMoveToFolderSheet(useAndroidMoveFolderPresentation);
