import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';

type KeyboardHandoffReturnViewProps = {
  mode: 'returning' | 'back_to_host';
  hostName: string | null;
  onCancel: () => void;
  onBackToHost: () => void;
};

/**
 * The keyboard handoff screen while OpenWhispr sends the user back to the app
 * they were typing in. Deliberately near-empty: it is on screen for about a
 * second, and sits behind the iOS "wants to open" prompt when iOS shows one.
 * No cancel while returning: the return can't be called off, so cancelling
 * would flash Home and then switch apps anyway.
 */
export function KeyboardHandoffReturnView({
  mode,
  hostName,
  onCancel,
  onBackToHost,
}: KeyboardHandoffReturnViewProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const showBackToHost = mode === 'back_to_host' && hostName;

  return (
    <View className="flex-1 bg-systemBackground" style={{ paddingTop: insets.top + 8 }}>
      <View className="h-9 flex-row justify-end px-5">
        {showBackToHost ? (
          <Pressable
            onPress={onCancel}
            hitSlop={8}
            className="w-9 h-9 rounded-full items-center justify-center bg-secondarySystemBackground active:opacity-70"
            accessibilityRole="button"
            accessibilityLabel="Cancel and discard"
          >
            <SystemIcon name="xmark" mdName="X" size={13} color="secondaryLabel" />
          </Pressable>
        ) : null}
      </View>

      <View className="flex-1 items-center justify-center px-8">
        {showBackToHost ? (
          <>
            <Text
              accessibilityRole="header"
              className="text-2xl font-semibold text-label text-center"
            >
              You&apos;re recording
            </Text>
            <Button
              onPress={onBackToHost}
              accessibilityRole="button"
              accessibilityLabel={`Back to ${hostName}`}
              className="mt-6 min-w-[200px]"
            >
              {`Back to ${hostName}`}
            </Button>
          </>
        ) : (
          <Text className="text-[15px] text-secondaryLabel text-center">
            Returning to your app…
          </Text>
        )}
      </View>
    </View>
  );
}
