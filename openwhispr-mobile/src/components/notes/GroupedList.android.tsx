import { createGroupedList } from './GroupedListCore';

export const GroupedList = createGroupedList(({ accessibilityActions, onAccessibilityAction }) => ({
  accessibilityActions,
  onAccessibilityAction,
}));
