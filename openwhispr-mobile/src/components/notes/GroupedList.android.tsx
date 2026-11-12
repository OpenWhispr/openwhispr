import { createGroupedList } from './GroupedListCore.android';

export const GroupedList = createGroupedList(({ accessibilityActions, onAccessibilityAction }) => ({
  accessibilityActions,
  onAccessibilityAction,
}));
