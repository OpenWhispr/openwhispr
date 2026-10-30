import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import type { ChatConversationSummary } from '@/lib/chat/types';
import { formatConversationTime } from './formatConversationTime';

interface ChatConversationRowProps {
  conversation: ChatConversationSummary;
  onPress: () => void;
  /** Offered to screen readers as an action, since a swipe to delete isn't available to them. */
  onDelete?: () => void;
}

export function ChatConversationRow({
  conversation,
  onPress,
  onDelete,
}: ChatConversationRowProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityActions={onDelete ? [{ name: 'delete', label: 'Delete chat' }] : undefined}
      onAccessibilityAction={({ nativeEvent }) => {
        if (nativeEvent.actionName === 'delete') onDelete?.();
      }}
      onPress={onPress}
      className="min-h-[64px] flex-row items-center gap-3 px-4 py-2.5 active:opacity-70"
    >
      <View className="flex-1">
        <Text className="text-[16px] font-semibold text-label" numberOfLines={1}>
          {conversation.title}
        </Text>
        <Text className="mt-0.5 text-[14px] text-secondaryLabel" numberOfLines={1}>
          {conversation.preview}
        </Text>
      </View>
      <Text className="text-[13px] text-secondaryLabel">
        {formatConversationTime(conversation.updatedAt)}
      </Text>
    </Pressable>
  );
}
