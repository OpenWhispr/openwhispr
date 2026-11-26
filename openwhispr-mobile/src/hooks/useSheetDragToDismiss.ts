import { useEffect } from 'react';
import { Dimensions } from 'react-native';
import { Gesture } from 'react-native-gesture-handler';
import {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

// Drag distance / fling velocity past which a downward pull dismisses the sheet.
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 800;
const SCREEN_HEIGHT = Dimensions.get('window').height;

export function shouldDismissSheetDrag(translationY: number, velocityY: number): boolean {
  'worklet';
  return translationY > DISMISS_DISTANCE || velocityY > DISMISS_VELOCITY;
}

/**
 * Pull-down-to-dismiss for a bottom sheet: attach `dragGesture` to the draggable area with a
 * GestureDetector and `sheetStyle` to the sheet. A short pull springs back; a long pull or a fling
 * slides the sheet away and then calls `onClose`.
 */
export function useSheetDragToDismiss(
  visible: boolean,
  onClose: () => void,
): {
  dragGesture: ReturnType<typeof Gesture.Pan>;
  sheetStyle: ReturnType<typeof useAnimatedStyle>;
} {
  const translateY = useSharedValue(0);

  useEffect(() => {
    if (visible) translateY.value = 0;
  }, [visible, translateY]);

  const dragGesture = Gesture.Pan()
    .activeOffsetY(10)
    .onUpdate((event) => {
      translateY.value = Math.max(0, event.translationY);
    })
    .onEnd((event) => {
      if (shouldDismissSheetDrag(event.translationY, event.velocityY)) {
        translateY.value = withTiming(SCREEN_HEIGHT, { duration: 200 }, () => {
          runOnJS(onClose)();
        });
      } else {
        translateY.value = withSpring(0, { damping: 20, stiffness: 220 });
      }
    });

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  return { dragGesture, sheetStyle };
}
