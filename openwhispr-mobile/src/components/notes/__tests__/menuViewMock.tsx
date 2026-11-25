import { useImperativeHandle, type ReactNode, type Ref } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { MenuAction, MenuComponentRef } from '@react-native-menu/menu';

export const showMenu = jest.fn();

function flatten(actions: MenuAction[]): MenuAction[] {
  return actions.flatMap((action) => (action.subactions ? flatten(action.subactions) : [action]));
}

/** Renders every menu action inline, so tests press them as `menu-<id>`. */
export function MenuView({
  ref,
  actions,
  onPressAction,
  children,
}: {
  ref?: Ref<MenuComponentRef>;
  actions: MenuAction[];
  onPressAction: (event: { nativeEvent: { event: string } }) => void;
  children?: ReactNode;
}) {
  useImperativeHandle(ref, () => ({ show: showMenu }), []);
  return (
    <View>
      {children}
      {flatten(actions).map((action) => (
        <Pressable
          key={action.id}
          testID={`menu-${action.id}`}
          accessibilityState={{
            disabled: Boolean(action.attributes?.disabled),
            selected: action.state === 'on',
          }}
          onPress={() => onPressAction({ nativeEvent: { event: action.id ?? '' } })}
        >
          <Text>{action.title}</Text>
        </Pressable>
      ))}
    </View>
  );
}
