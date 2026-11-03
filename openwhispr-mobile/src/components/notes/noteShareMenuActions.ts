import { Platform } from 'react-native';
import type { MenuAction } from '@react-native-menu/menu';

/** Android ignores displayInline and otherwise renders our untitled sections as blank submenus. */
export function noteShareMenuActions(actions: MenuAction[]): MenuAction[] {
  if (Platform.OS !== 'android') return actions;
  return actions.flatMap((action) =>
    action.displayInline && action.subactions ? action.subactions : [action],
  );
}
