import { useRef, useState, type ReactElement } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useSheetDragToDismiss } from '@/hooks/useSheetDragToDismiss';
import { describeOnboardingError } from '@/lib/onboardingErrors';

interface Props {
  visible: boolean;
  onContinueCloud: () => Promise<void>;
  onKeepWaiting: () => void;
}

export function SlowDownloadSheet({
  visible,
  onContinueCloud,
  onKeepWaiting,
}: Props): ReactElement {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const continueCloud = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onContinueCloud();
    } catch (cause) {
      setError(describeOnboardingError(cause, 'Cloud is unavailable. Try again.'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const keepWaiting = (): void => {
    if (!inFlight.current) {
      setError(null);
      onKeepWaiting();
    }
  };
  // Pulling the sheet down means the same as Keep waiting.
  const { dragGesture, sheetStyle } = useSheetDragToDismiss(visible, keepWaiting);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={keepWaiting}>
      <GestureHandlerRootView className="flex-1">
        <Pressable
          accessibilityLabel="Dismiss"
          onPress={keepWaiting}
          className="absolute inset-0 bg-black/40"
        />
        <GestureDetector gesture={dragGesture}>
          <Animated.View
            style={sheetStyle}
            className="absolute bottom-0 left-0 right-0 rounded-t-3xl bg-systemBackground px-6 pb-8 pt-3"
          >
            <View className="mb-4 h-1 w-9 self-center rounded-full bg-separator" />
            <Text className="text-[22px] font-bold text-label">Download taking a while?</Text>
            <Text className="mt-1.5 text-[15px] leading-[20px] text-secondaryLabel">
              No need to wait. Continue setup on Cloud now — we&apos;ll finish your Private download
              in the background.
            </Text>

            <View className="mt-4 rounded-2xl border border-separator bg-secondarySystemGroupedBackground p-4">
              <View className="flex-row items-center gap-2">
                <SystemIcon name="cloud.fill" mdName="Cloud" size={16} color="brand" />
                <Text className="flex-1 text-[13px] leading-[18px] text-secondaryLabel">
                  Turn the Cloud toggle <Text className="font-semibold text-label">off</Text> on the
                  home screen to switch to Private once it&apos;s ready.
                </Text>
              </View>
            </View>

            <View className="mt-5">
              {error ? (
                <Text accessibilityRole="alert" className="mb-3 text-systemRed">
                  {error}
                </Text>
              ) : null}
              <Button onPress={() => void continueCloud()} loading={busy} size="lg">
                Continue with Cloud for now
              </Button>
              <Pressable
                onPress={keepWaiting}
                className="mt-3 items-center py-2"
                accessibilityRole="button"
                accessibilityLabel="Keep waiting for download"
              >
                <Text className="text-[15px] font-medium text-secondaryLabel">Keep waiting</Text>
              </Pressable>
            </View>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}
