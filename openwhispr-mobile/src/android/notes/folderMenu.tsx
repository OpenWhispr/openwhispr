import React, { useState } from 'react';
import { View } from 'react-native';
import type { Folder } from '@/data';
import { useNotesStore } from '@/android/store/useNotesStore';
import { safeHaptics } from '@/lib/utils';
import { BottomSheet, TextAction } from '../settings/kit';
import { Card, ListRow } from './look';
import { FolderNameSheet } from './sheets';
import { useNotesT } from './strings';

/**
 * Long-press a folder: Rename, and Delete behind a confirm sheet (a folder takes its notes
 * with it, so it keeps today's confirm). Default folders can't be deleted; teamspace folders
 * only by the space's admins.
 */
export function useFolderMenu() {
  const t = useNotesT();
  const [folder, setFolder] = useState<{ value: Folder; canDelete: boolean } | null>(null);
  const [step, setStep] = useState<'menu' | 'rename' | 'confirm' | null>(null);
  const close = () => setStep(null);
  const count = folder ? (useNotesStore.getState().folderCounts[folder.value.id] ?? 0) : 0;
  return {
    /** `teamAdmin`: the folder is in a teamspace this person admins (else private). */
    open(value: Folder, inTeam: boolean, teamAdmin = false) {
      safeHaptics('medium');
      setFolder({ value, canDelete: !value.isDefault && (!inTeam || teamAdmin) });
      setStep('menu');
    },
    sheets: (
      <>
        <BottomSheet visible={step === 'menu'} onClose={close} title={folder?.value.name ?? ''}>
          <Card>
            <ListRow
              icon="Pencil"
              title={t('renameFolder')}
              chevron={false}
              onPress={() => setStep('rename')}
            />
            {folder?.canDelete ? (
              <ListRow
                icon="Trash2"
                destructive
                title={t('deleteFolder')}
                chevron={false}
                onPress={() => setStep('confirm')}
              />
            ) : null}
          </Card>
        </BottomSheet>
        <FolderNameSheet
          visible={step === 'rename'}
          onClose={close}
          initialName={folder?.value.name}
          title={t('renameFolder')}
          submitLabel={t('renameFolder')}
          onSubmit={(name) =>
            folder && useNotesStore.getState().renameFolder(folder.value.id, name)
          }
        />
        <BottomSheet
          visible={step === 'confirm'}
          onClose={close}
          title={t('deleteFolderTitle', { name: folder?.value.name ?? '' })}
          body={count > 0 ? t('deleteFolderBody', { count }) : t('deleteFolderEmptyBody')}
        >
          <View>
            <TextAction
              destructive
              label={t('deleteFolder')}
              onPress={() => {
                if (folder) {
                  safeHaptics('warning');
                  useNotesStore.getState().deleteFolderSafe(folder.value.id);
                }
                close();
              }}
            />
            <TextAction label={t('cancel')} onPress={close} />
          </View>
        </BottomSheet>
      </>
    ),
  };
}
