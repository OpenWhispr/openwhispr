import type { ReactElement } from 'react';
import { Pressable, View } from 'react-native';
import { MenuView, type MenuAction } from '@react-native-menu/menu';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GroupedList } from './GroupedList';
import { safeHaptics } from '@/lib/utils';
import { privateWorkspaceOptions, type PrivateWorkspace } from '@/lib/privateWorkspaces';

type PrivateWorkspaceSwitcherProps = {
  workspaces: PrivateWorkspace[];
  activeId: string | null;
  defaultId: string | null;
  onSelect: (workspaceId: string | null) => void;
};

const UNASSIGNED_PRIVATE_ID = 'unassigned-private';

/**
 * Picks the workspace whose Private and team spaces the Folders screen shows, as desktop's
 * workspace switcher does. Renders only when there is more than one Private section.
 */
export function PrivateWorkspaceSwitcher({
  workspaces,
  activeId,
  defaultId,
  onSelect,
}: PrivateWorkspaceSwitcherProps): ReactElement | null {
  const options = privateWorkspaceOptions(workspaces, defaultId);
  if (options.length < 2) return null;
  const current = options.find((workspace) => workspace.id === activeId) ?? options[0];

  const actions: MenuAction[] = options.map((workspace) => ({
    id: workspace.id ?? UNASSIGNED_PRIVATE_ID,
    title: workspace.name,
    state: workspace.id === current.id ? 'on' : 'off',
  }));

  return (
    <MenuView
      title="Switch workspace"
      actions={actions}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => {
        const selectedId = nativeEvent.event === UNASSIGNED_PRIVATE_ID ? null : nativeEvent.event;
        if (selectedId === current.id) return;
        safeHaptics('selection');
        onSelect(selectedId);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Workspace: ${current.name}`}
        accessibilityHint="Switches the workspace whose notes are shown"
      >
        <GroupedList>
          <GroupedList.Row
            leadingIconSlot={
              <SystemIcon name="building.2" mdName="Building2" size={22} color="brand" />
            }
          >
            <View className="flex-row items-center justify-between gap-2">
              <Text numberOfLines={1} className="flex-shrink text-[17px] text-label">
                {current.name}
              </Text>
              <SystemIcon
                name="chevron.up.chevron.down"
                mdName="ChevronsUpDown"
                size={14}
                color="tertiaryLabel"
              />
            </View>
          </GroupedList.Row>
        </GroupedList>
      </Pressable>
    </MenuView>
  );
}
