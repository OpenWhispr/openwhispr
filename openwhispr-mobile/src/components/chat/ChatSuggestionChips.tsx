import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/Text';
import { CHAT_COLORS } from '@/config/colors';
import type { ChatSuggestion } from '@/lib/chat/chatSuggestions';

interface ChatSuggestionChipsProps {
  suggestions: ChatSuggestion[];
  onPress: (suggestion: ChatSuggestion) => void;
  disabled: boolean;
}

/** One scrolling row of questions to ask, sitting on the composer. */
export function ChatSuggestionChips({
  suggestions,
  onPress,
  disabled,
}: ChatSuggestionChipsProps): React.JSX.Element {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      // A tap while typing asks the question rather than only closing the keyboard.
      keyboardShouldPersistTaps="handled"
      className="-mx-4 mb-2.5"
      contentContainerStyle={styles.content}
    >
      {suggestions.map((suggestion) => (
        <Pressable
          key={suggestion.label}
          accessibilityRole="button"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => onPress(suggestion)}
          hitSlop={2}
          className="min-h-[40px] justify-center bg-secondarySystemGroupedBackground px-3.5 active:opacity-70"
          style={[styles.chip, disabled && styles.disabled]}
        >
          <Text numberOfLines={1} className="text-[15px] text-label" style={styles.label}>
            {suggestion.label}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, gap: 8 },
  chip: {
    borderRadius: 12,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: CHAT_COLORS.hairline,
  },
  // A long meeting name is cut short rather than filling the row.
  label: { maxWidth: 260 },
  disabled: { opacity: 0.4 },
});
