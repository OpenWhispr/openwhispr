import { withSpring, type SharedValue } from 'react-native-reanimated';
import { useSheetDragToDismissCore } from './useSheetDragToDismissCore';

export { shouldDismissSheetDrag } from './useSheetDragToDismissCore';
function closeOrRestore(onClose: () => void | boolean, translateY: SharedValue<number>): void {
  // Keep a dirty form visible behind its confirmation alert.
  if (onClose() === false) translateY.value = withSpring(0, { damping: 20, stiffness: 220 });
}
export function useSheetDragToDismiss(visible: boolean, onClose: () => void | boolean) {
  return useSheetDragToDismissCore(visible, onClose, closeOrRestore);
}
