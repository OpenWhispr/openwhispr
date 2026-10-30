import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';

interface ChatComposerNoticeProps {
  label: string;
  /** Makes the line a button, e.g. to open the chat that's working. */
  onPress?: () => void;
}

/** One line above the composer saying what's holding it. */
export function ChatComposerNotice({ label, onPress }: ChatComposerNoticeProps): React.JSX.Element {
  const text = (
    <Text numberOfLines={1} className="text-[13px] text-secondaryLabel">
      {label}
    </Text>
  );
  if (!onPress) return <View className="px-1 pb-2">{text}</View>;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      className="min-h-[44px] justify-center px-1"
    >
      {text}
    </Pressable>
  );
}
