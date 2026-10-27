import { shouldDismissSheetDrag } from '../useSheetDragToDismiss';

jest.mock('react-native-reanimated', () => ({}));
jest.mock('react-native-gesture-handler', () => ({}));

it.each([
  ['a short pull', 60, 200, false],
  ['a pull past the distance', 140, 100, true],
  ['a quick fling', 40, 1200, true],
  ['an upward drag', -200, -1500, false],
])('treats %s as dismiss=%s', (_label, translationY, velocityY, expected) => {
  expect(shouldDismissSheetDrag(translationY, velocityY)).toBe(expected);
});
