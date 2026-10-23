import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { MarkdownRenderer } from '@/components/notes/MarkdownRenderer';
import { CHAT_COLORS } from '@/config/colors';
import { safeHaptics } from '@/lib/utils';
import type { ChatMessage } from '@/lib/chat/types';
import { ChatSteps } from './ChatSteps';

interface ChatAssistantMessageProps {
  message: ChatMessage;
  onOpenNote: (noteId: number) => void;
}

// As long as the referral link's copy confirmation stays.
const COPIED_MS = 2_000;

export function ChatAssistantMessage({
  message,
  onOpenNote,
}: ChatAssistantMessageProps): React.JSX.Element {
  // Counts the copies while "Copied" shows, so each one restarts its timer.
  const [copies, setCopies] = useState(0);
  const copied = copies > 0;

  useEffect(() => {
    if (copies === 0) return undefined;
    const timer = setTimeout(() => setCopies(0), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copies]);

  const copy = async (): Promise<void> => {
    safeHaptics('light');
    try {
      await Clipboard.setStringAsync(message.text);
    } catch {
      // The clipboard can refuse a write; there is nothing useful to tell the user.
      return;
    }
    setCopies((count) => count + 1);
    AccessibilityInfo.announceForAccessibility('Copied');
  };

  return (
    <View className="gap-1 self-stretch">
      {/* A message saved without steps never searched, so claiming it did would mislead. */}
      {message.steps.length > 0 ? (
        <ChatSteps steps={message.steps} variant="done" sourceCount={message.sources.length} />
      ) : null}
      <MarkdownRenderer content={message.text} selectable />
      {message.sources.length > 0 ? (
        <View className="mt-2 flex-row flex-wrap gap-2">
          {message.sources.map((source) => (
            <Pressable
              key={source.noteId}
              accessibilityRole="link"
              accessibilityLabel={source.title}
              onPress={() => onOpenNote(source.noteId)}
              className="min-h-[44px] max-w-full flex-row items-center gap-1.5 rounded-[10px] bg-secondarySystemGroupedBackground px-3 active:opacity-70"
              style={styles.chip}
            >
              <SystemIcon name="doc.text" mdName="FileText" size={14} color="secondaryLabel" />
              <Text className="shrink text-[14px] text-label" numberOfLines={1}>
                {source.title}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View className="mt-1 flex-row items-center">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy answer"
          onPress={copy}
          className="h-11 w-11 items-center justify-center active:opacity-60"
        >
          <SystemIcon
            name={copied ? 'checkmark' : 'doc.on.doc'}
            mdName={copied ? 'Check' : 'Copy'}
            size={18}
            color={copied ? 'systemGreen' : 'secondaryLabel'}
          />
        </Pressable>
        {copied ? <Text className="text-[13px] text-secondaryLabel">Copied</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { borderWidth: StyleSheet.hairlineWidth, borderColor: CHAT_COLORS.hairline },
});
