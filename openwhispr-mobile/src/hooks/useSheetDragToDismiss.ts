import { useSheetDragToDismissCore } from './useSheetDragToDismissCore';

export { shouldDismissSheetDrag } from './useSheetDragToDismissCore';
export function useSheetDragToDismiss(visible: boolean, onClose: () => void) {
  return useSheetDragToDismissCore(visible, onClose);
}
