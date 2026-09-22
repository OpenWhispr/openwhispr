import { type ReactNode, useEffect } from 'react';
import { Dimensions, Modal, Pressable, ScrollView, View, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { GradientGlassSurface } from '@/components/ui/GradientGlassSurface';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';

const SHEET_RADIUS = 28;
// Gap below the safe-area inset, leaving a sliver of the dimmed screen above the
// sheet — the native "large detent" look.
const SHEET_TOP_PEEK = 8;
// Breathing room between the primary button and the keyboard's top edge.
const BUTTON_KEYBOARD_GAP = 10;
// Drag distance / fling velocity past which a downward pull dismisses the sheet.
const DISMISS_DISTANCE = 110;
const DISMISS_VELOCITY = 800;
const SCREEN_HEIGHT = Dimensions.get('window').height;

const SUBMIT_SHADOW: ViewStyle = {
  shadowColor: '#2457D6',
  shadowOpacity: 0.35,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 8 },
  elevation: 4,
};

type FormSheetProps = {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  submitLabel: string;
  canSubmit: boolean;
  onSubmit: () => void;
  // Optional recessed action shown beneath the primary button (e.g. Delete).
  destructiveAction?: { label: string; onPress: () => void };
  children: ReactNode;
};

/**
 * Full-height bottom sheet for short input forms. The sheet background is pinned
 * to the bottom of the screen so it fills the area behind the keyboard (no gaps
 * at the keyboard's top corners), while only the content is lifted by the live
 * keyboard height — keeping the primary button docked just above the keyboard.
 * The grabber/header can be dragged down to dismiss. Provides the glass close
 * button and gradient-glass primary action; callers supply the form body.
 */
export function FormSheet({
  visible,
  onClose,
  title,
  subtitle,
  submitLabel,
  canSubmit,
  onSubmit,
  destructiveAction,
  children,
}: FormSheetProps) {
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight(visible);
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
      if (event.translationY > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY) {
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

  const bottomPad =
    keyboardHeight > 0 ? keyboardHeight + BUTTON_KEYBOARD_GAP : Math.max(insets.bottom, 16);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Pressable
          accessibilityLabel="Dismiss"
          onPress={onClose}
          className="absolute inset-0 bg-black/40"
        />

        <Animated.View
          style={[
            {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              top: insets.top + SHEET_TOP_PEEK,
              borderTopLeftRadius: SHEET_RADIUS,
              borderTopRightRadius: SHEET_RADIUS,
              borderCurve: 'continuous',
            },
            sheetStyle,
          ]}
          className="bg-systemBackground"
        >
          <View style={{ flex: 1, paddingBottom: bottomPad }} className="px-5 pt-3.5">
            <GestureDetector gesture={dragGesture}>
              <View>
                <View className="mb-2 self-center h-1.5 w-9 rounded-full bg-quaternaryLabel" />
                <View className="flex-row items-start justify-between">
                  <View className="flex-1 pr-3">
                    <Text className="text-[19px] font-bold text-label">{title}</Text>
                    {subtitle ? (
                      <Text className="mt-1 text-[13px] text-secondaryLabel">{subtitle}</Text>
                    ) : null}
                  </View>
                  <GlassIconButton onPress={onClose} accessibilityLabel="Close" size={30}>
                    <SystemIcon name="xmark" mdName="X" size={13} color="secondaryLabel" />
                  </GlassIconButton>
                </View>
              </View>
            </GestureDetector>

            <ScrollView
              className="mt-4 flex-1"
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {children}
            </ScrollView>

            <Pressable
              onPress={onSubmit}
              disabled={!canSubmit}
              style={({ pressed }) => [
                canSubmit ? SUBMIT_SHADOW : null,
                { borderCurve: 'continuous', opacity: pressed && canSubmit ? 0.9 : 1 },
              ]}
              className={`relative h-[52px] items-center justify-center rounded-full ${
                canSubmit ? 'bg-link' : 'bg-quaternarySystemFill'
              }`}
            >
              {canSubmit ? <GradientGlassSurface /> : null}
              <Text
                className={`text-[16px] font-semibold ${
                  canSubmit ? 'text-white' : 'text-tertiaryLabel'
                }`}
              >
                {submitLabel}
              </Text>
            </Pressable>

            {destructiveAction ? (
              <Pressable
                onPress={destructiveAction.onPress}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                className="mt-2.5 h-11 items-center justify-center"
              >
                <Text className="text-[16px] font-semibold text-systemRed">
                  {destructiveAction.label}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </Animated.View>
      </GestureHandlerRootView>
    </Modal>
  );
}
