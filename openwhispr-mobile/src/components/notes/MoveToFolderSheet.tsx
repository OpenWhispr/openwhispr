import { Modal, View, ScrollView, Alert } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GroupedList } from './GroupedList';
import { FolderRow } from './FolderRow';
import { SpaceRow } from './SpaceRow';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { safeHaptics } from '@/lib/utils';
import type { Folder, Space } from '@/data';

type MoveToFolderSheetProps = {
  visible: boolean;
  /** The folders offered as targets, always from the same space as the note being moved: the
   * private space's folders for personal content, the browsed space's folders for space content.
   * Crossing scopes would file a note into a folder the server refuses. */
  folders: Folder[];
  folderCounts: Record<number, number>;
  excludeFolderId: number | null;
  onClose: () => void;
  onPickFolder: (folderId: number) => void;
  onCreateAndPick: (name: string) => void;
  /** The spaces this note may move to, already filtered by the caller (see canMoveBetweenSpaces):
   * team content never leaves its workspace and never returns to the private space, so a team
   * note is only ever offered its workspace's other spaces. Omitted/empty (the default) renders
   * exactly as before spaces existed — zero visual change for personal-only users. */
  spaces?: Space[];
  /** The space the note currently lives in, if it is a team space — set both when browsing the
   * space itself and when browsing one of its folders. Only distinguishes the sheet's title. */
  activeSpaceId?: number | null;
  onPickSpace?: (spaceId: number) => void;
};

export function MoveToFolderSheet({
  visible,
  folders,
  folderCounts,
  excludeFolderId,
  onClose,
  onPickFolder,
  onCreateAndPick,
  spaces = [],
  activeSpaceId = null,
  onPickSpace,
}: MoveToFolderSheetProps) {
  const insets = useSafeAreaInsets();
  const targets = folders.filter((f) => f.id !== excludeFolderId && !f.deletedAt);
  const title = activeSpaceId == null ? 'Move to Folder' : 'Move Note';

  const handleCreate = () => {
    Alert.prompt('New Folder', 'Enter a name for the new folder', (text) => {
      const trimmed = text?.trim();
      if (trimmed) {
        safeHaptics('success');
        onCreateAndPick(trimmed);
      }
    });
  };

  const handlePick = (folderId: number) => {
    safeHaptics('selection');
    onPickFolder(folderId);
  };

  const handlePickSpace = (spaceId: number) => {
    safeHaptics('selection');
    onPickSpace?.(spaceId);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View className="flex-1 bg-systemBackground">
        <View className="flex-row items-center justify-between px-6 pb-4 pt-8">
          <Text className="text-[22px] font-bold text-label">{title}</Text>
          <GlassIconButton onPress={onClose} accessibilityLabel="Close">
            <SystemIcon name="xmark" mdName="X" size={15} color="secondaryLabel" />
          </GlassIconButton>
        </View>

        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 24,
            paddingBottom: insets.bottom + 24,
            gap: 16,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <GroupedList>
            <GroupedList.Row
              onPress={handleCreate}
              accessibilityRole="button"
              accessibilityLabel="Create new folder"
              leadingIconSlot={
                <SystemIcon name="folder.badge.plus" mdName="FolderPlus" size={22} color="brand" />
              }
            >
              <Text className="text-[17px] font-medium text-link">Create New Folder</Text>
            </GroupedList.Row>
          </GroupedList>

          {targets.length > 0 && (
            <GroupedList>
              {targets.map((folder) => (
                <FolderRow
                  key={folder.id}
                  sfName="folder"
                  mdName="Folder"
                  label={folder.name}
                  count={folderCounts[folder.id] ?? 0}
                  onPress={() => handlePick(folder.id)}
                />
              ))}
            </GroupedList>
          )}

          {spaces.length > 0 && (
            <View className="gap-2">
              <Text className="px-1 text-[13px] uppercase tracking-wider text-secondaryLabel">
                Spaces
              </Text>
              <GroupedList>
                {spaces.map((space) => (
                  <SpaceRow
                    key={space.id}
                    space={space}
                    onPress={() => handlePickSpace(space.id)}
                  />
                ))}
              </GroupedList>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
