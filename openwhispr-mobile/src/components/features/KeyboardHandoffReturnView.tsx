import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
 */
export function KeyboardHandoffReturnView({
  mode,
  hostName,
  onCancel,
  onBackToHost,
}: KeyboardHandoffReturnViewProps): React.JSX.Element {
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-systemBackground" style={{ paddingTop: insets.top + 8 }}>
      <View className="flex-row justify-end px-5">
        <Pressable
          onPress={onCancel}
          hitSlop={8}
          className="w-9 h-9 rounded-full items-center justify-center bg-secondarySystemBackground active:opacity-70"
          accessibilityLabel="Cancel and discard"
        >
          <SystemIcon name="xmark" mdName="X" size={13} color="secondaryLabel" />
        </Pressable>
      </View>

      <View className="flex-1 items-center justify-center px-8">
        {mode === 'back_to_host' && hostName ? (
          <>
            <Text className="text-2xl font-semibold text-label text-center">
              You&apos;re recording
            </Text>
            <Pressable
              onPress={onBackToHost}
              accessibilityRole="button"
              accessibilityLabel={`Back to ${hostName}`}
              className="mt-6 h-12 min-w-[200px] items-center justify-center rounded-full bg-brand px-6 active:opacity-80"
            >
              <Text className="text-base font-semibold text-white">{`Back to ${hostName}`}</Text>
            </Pressable>
          </>
        ) : (
          <Text className="text-[15px] text-secondaryLabel text-center">Returning to your app…</Text>
        )}
      </View>
    </View>
  );
}
