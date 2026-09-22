import { useRef } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { MarkdownRenderer } from '@/components/notes/MarkdownRenderer';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { BRAND } from '@/config/colors';
import type { ChatOverNoteMessage } from '@/lib/notes/chatOverNote';

const INPUT_KEYBOARD_GAP = 10;

interface NoteChatSheetProps {
  visible: boolean;
  messages: ChatOverNoteMessage[];
  draft: string;
  isProcessing: boolean;
  error: string | null;
  canSend: boolean;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onRetry: () => void;
  onClear: () => void;
  onClose: () => void;
}

export function NoteChatSheet({
  visible,
  messages,
  draft,
  isProcessing,
  error,
  canSend,
  onDraftChange,
  onSend,
  onRetry,
  onClear,
  onClose,
}: NoteChatSheetProps) {
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const keyboardHeight = useKeyboardHeight(visible);
  const canSubmit = canSend && draft.trim().length > 0 && !isProcessing;
  const hasMessages = messages.length > 0;
  const sheetHeight = Math.min(windowHeight * 0.82, windowHeight - insets.top - 8);
  const bottomPad =
    keyboardHeight > 0 ? keyboardHeight + INPUT_KEYBOARD_GAP : Math.max(insets.bottom, 14);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityLabel="Dismiss note chat"
          onPress={onClose}
          className="absolute inset-0 bg-black/40"
        />
        <View
          className="rounded-t-[28px] bg-systemBackground px-5 pt-3"
          style={{
            height: sheetHeight,
            paddingBottom: bottomPad,
            borderCurve: 'continuous',
          }}
        >
          <View className="mb-2 self-center h-1.5 w-9 rounded-full bg-quaternaryLabel" />
          <View className="mb-3 flex-row items-center justify-between">
            <View className="flex-1 pr-3">
              <Text className="text-[19px] font-bold text-label">Ask about this note</Text>
              <Text className="mt-1 text-[13px] text-secondaryLabel">
                Answers use only this note and this chat.
              </Text>
            </View>
            {hasMessages ? (
              <Pressable
                onPress={onClear}
                disabled={isProcessing}
                className="mr-2 px-2 py-1"
                accessibilityRole="button"
                accessibilityLabel="Clear chat"
              >
                <Text className="text-[14px] font-medium text-link">Clear</Text>
              </Pressable>
            ) : null}
            <GlassIconButton onPress={onClose} accessibilityLabel="Close chat" size={30}>
              <SystemIcon name="xmark" mdName="X" size={13} color="secondaryLabel" />
            </GlassIconButton>
          </View>

          <ScrollView
            ref={scrollRef}
            className="min-h-[220px] flex-1"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {!hasMessages ? (
              <View className="min-h-[200px] justify-center">
                <Text className="text-[15px] font-medium text-label">
                  Ask for decisions, action items, quotes, or who said what.
                </Text>
                <Text className="mt-2 text-[14px] leading-5 text-secondaryLabel">
                  The conversation is temporary and will not be saved.
                </Text>
              </View>
            ) : (
              <View className="gap-3 pb-3">
                {messages.map((message) => {
                  const isUser = message.role === 'user';
                  return (
                    <View
                      key={message.id}
                      className={`max-w-[86%] rounded-[18px] px-3 py-2 ${
                        isUser ? 'self-end bg-brand' : 'self-start bg-secondarySystemBackground'
                      }`}
                      style={{ borderCurve: 'continuous' }}
                    >
                      {isUser ? (
                        <Text className="text-[15px] leading-5 text-white">{message.text}</Text>
                      ) : (
                        <MarkdownRenderer content={message.text} />
                      )}
                    </View>
                  );
                })}
                {isProcessing ? (
                  <View
                    className="max-w-[86%] self-start rounded-[18px] bg-secondarySystemBackground px-3 py-2"
                    style={{ borderCurve: 'continuous' }}
                  >
                    <View className="flex-row items-center gap-2">
                      <ActivityIndicator size="small" color={BRAND} />
                      <Text className="text-[14px] text-secondaryLabel">Thinking...</Text>
                    </View>
                  </View>
                ) : null}
              </View>
            )}
          </ScrollView>

          {error ? (
            <View className="mb-2 rounded-xl bg-tertiarySystemFill px-3 py-2">
              <Text className="text-[13px] text-secondaryLabel">{error}</Text>
              <Pressable
                onPress={onRetry}
                disabled={isProcessing}
                className="mt-1 self-start py-1"
                accessibilityRole="button"
                accessibilityLabel="Retry chat question"
              >
                <Text className="text-[13px] font-semibold text-link">Retry</Text>
              </Pressable>
            </View>
          ) : null}

          <View className="flex-row items-end gap-2 rounded-[22px] bg-secondarySystemBackground px-3 py-2">
            <TextInput
              value={draft}
              onChangeText={onDraftChange}
              placeholder={canSend ? 'Ask a question...' : 'No note content to ask about'}
              placeholderTextColor="rgba(60,60,67,0.35)"
              multiline
              editable={canSend && !isProcessing}
              className="max-h-[110px] flex-1 py-1 text-[16px] leading-5 text-label"
              textAlignVertical="top"
            />
            <Pressable
              onPress={onSend}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel="Send question"
              className={`h-9 w-9 items-center justify-center rounded-full ${
                canSubmit ? 'bg-brand' : 'bg-tertiarySystemFill'
              }`}
            >
              <SystemIcon
                name="arrow.up"
                mdName="ArrowUp"
                size={18}
                color={canSubmit ? '#FFFFFF' : 'tertiaryLabel'}
              />
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
