import { useEffect, type ReactElement } from 'react';
import { View } from 'react-native';
import { MenuView, type MenuAction } from '@react-native-menu/menu';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { useNotesStore } from '@/store/useNotesStore';
import { safeHaptics } from '@/lib/utils';
import { privateWorkspaceOptions, UNASSIGNED_PRIVATE_ID } from '@/lib/privateWorkspaces';

/** Wraps the Folders heading, or renders a standalone Account row. */
export function PrivateWorkspaceSwitcher({
  heading,
}: {
  heading?: ReactElement;
}): ReactElement | null {
  const workspaces = useNotesStore((state) => state.privateWorkspaces);
  const activeId = useNotesStore((state) => state.activePrivateWorkspaceId);
  const defaultId = useNotesStore((state) => state.defaultPrivateWorkspaceId);
  const onSelect = useNotesStore((state) => state.setActivePrivateWorkspace);
  const isInitialized = useNotesStore((state) => state.isInitialized);
  const initialize = useNotesStore((state) => state.initialize);

  useEffect(() => {
    if (!isInitialized) initialize();
  }, [isInitialized, initialize]);

  const options = privateWorkspaceOptions(workspaces, defaultId);
  if (options.length < 2) return heading ?? null;
  const current = options.find((workspace) => workspace.id === activeId) ?? options[0];

  const actions: MenuAction[] = options.map((workspace) => ({
    id: workspace.id ?? UNASSIGNED_PRIVATE_ID,
    title: workspace.name,
    state: workspace.id === current.id ? 'on' : 'off',
  }));

  const workspaceName = (
    <View
      className={
        heading
          ? 'max-w-full flex-row items-center gap-1'
          : 'max-w-[55%] flex-row items-center gap-1.5'
      }
    >
      <Text
        numberOfLines={1}
        className={heading ? 'shrink text-[13px] text-brand' : 'shrink text-[15px] text-brand'}
      >
        {current.name}
      </Text>
      <SystemIcon name="chevron.down" mdName="ChevronDown" size={heading ? 10 : 13} color="brand" />
    </View>
  );

  const menu = (
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
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`${heading ? 'Folders, ' : ''}Workspace: ${current.name}`}
        accessibilityHint="Switches the workspace whose notes are shown"
        pointerEvents="none"
        className={heading ? 'min-h-[44px] items-center justify-center px-2' : undefined}
      >
        {heading ? (
          <>
            {heading}
            {workspaceName}
          </>
        ) : (
          <SettingsRow
            iconStyle="line"
            icon="building.2"
            mdIcon="Building2"
            title="Workspace"
            rightElement={workspaceName}
          />
        )}
      </View>
    </MenuView>
  );

  return heading ? menu : <SettingsSection>{menu}</SettingsSection>;
}
