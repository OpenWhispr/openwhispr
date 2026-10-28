import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';

interface ChatTurnedOffProps {
  onOpenSettings: () => void;
}

export function ChatTurnedOff({ onOpenSettings }: ChatTurnedOffProps): React.JSX.Element {
  return (
    <View className="flex-1 items-center justify-center gap-2 px-8">
      <Text accessibilityRole="header" className="text-[20px] font-semibold text-label">
        Chat is turned off
      </Text>
      <Text className="text-center text-[15px] text-secondaryLabel">
        Turn it on in Chat settings.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={onOpenSettings}
        className="mt-3 min-h-[44px] justify-center rounded-[12px] bg-tertiarySystemFill px-5 active:opacity-70"
      >
        <Text className="text-[16px] font-semibold text-link">Open Chat settings</Text>
      </Pressable>
    </View>
  );
}
