import type { ReactElement } from 'react';
import { Linking, Modal, Pressable, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { useSheetDragToDismiss } from '@/hooks/useSheetDragToDismiss';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Fires once the sheet has fully gone, the first moment iOS will accept a focus request again. */
  onDismissed: () => void;
}

const FIXES: { problem: string; fix: string }[] = [
  {
    problem: 'Not in the list?',
    fix: 'Turn on OpenWhispr in Settings → Keyboards, then come back.',
  },
  {
    problem: 'Can’t find the globe?',
    fix: 'It’s below the letters, bottom left. If you see 😀 instead, press and hold that.',
  },
  {
    problem: 'Switched but nothing happened?',
    fix: 'Turn on Allow Full Access in Settings → Keyboards.',
  },
];

// The keyboard covers the switch step's own button, so this sheet is where someone stuck on the
// step finds the fixes. It deliberately offers no way past the step: the app can't be used
// without the keyboard, and it is much harder to debug once onboarding is over.
export function KeyboardSwitchHelpSheet({ visible, onClose, onDismissed }: Props): ReactElement {
  const { dragGesture, sheetStyle } = useSheetDragToDismiss(visible, onClose);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={onDismissed}
    >
      <GestureHandlerRootView className="flex-1">
        <Pressable
          accessibilityLabel="Dismiss"
          onPress={onClose}
          className="absolute inset-0 bg-black/40"
        />
        <GestureDetector gesture={dragGesture}>
          <Animated.View
            style={sheetStyle}
            className="absolute bottom-0 left-0 right-0 rounded-t-3xl bg-systemBackground px-6 pb-8 pt-3"
          >
            <View className="mb-4 h-1 w-9 self-center rounded-full bg-separator" />
            <Text accessibilityRole="header" className="text-[22px] font-bold text-label">
              Can’t switch to OpenWhispr?
            </Text>

            <View className="mt-4 gap-3">
              {FIXES.map(({ problem, fix }) => (
                <Text key={problem} className="text-[15px] leading-[21px] text-secondaryLabel">
                  <Text className="font-semibold text-label">{problem}</Text> {fix}
                </Text>
              ))}
            </View>

            <View className="mt-6">
              <Button onPress={() => Linking.openSettings()} size="lg">
                Open Settings
              </Button>
              <Pressable
                onPress={onClose}
                className="mt-3 items-center py-2"
                accessibilityRole="button"
              >
                <Text className="text-[15px] font-medium text-secondaryLabel">Close</Text>
              </Pressable>
            </View>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}
