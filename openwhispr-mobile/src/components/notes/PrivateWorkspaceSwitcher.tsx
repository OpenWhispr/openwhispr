import { Pressable, View } from 'react-native';
import { MenuView, type MenuAction } from '@react-native-menu/menu';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { GroupedList } from './GroupedList';
import { safeHaptics } from '@/lib/utils';
import type { PrivateWorkspace } from '@/lib/privateWorkspaces';

type PrivateWorkspaceSwitcherProps = {
  workspaces: PrivateWorkspace[];
  activeId: string | null;
  onSelect: (workspaceId: string) => void;
};

/**
 * Picks the workspace whose Private and team spaces the Folders screen shows, as desktop's
 * workspace switcher does. Renders nothing for an account with a single workspace.
 */
export function PrivateWorkspaceSwitcher({
  workspaces,
  activeId,
  onSelect,
}: PrivateWorkspaceSwitcherProps) {
  if (workspaces.length < 2) return null;
  const current = workspaces.find((w) => w.id === activeId) ?? workspaces[0];

  const actions: MenuAction[] = workspaces.map((workspace) => ({
    id: workspace.id,
    title: workspace.name,
    state: workspace.id === current.id ? 'on' : 'off',
  }));

  return (
    <MenuView
      title="Switch workspace"
      actions={actions}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === current.id) return;
        safeHaptics('selection');
        onSelect(nativeEvent.event);
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
