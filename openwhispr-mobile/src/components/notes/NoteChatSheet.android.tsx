import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { useRef } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
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
import { useIosColor } from '@/config/colors.android';
import type { ChatOverNoteMessage } from '@/lib/notes/chatOverNote';
import type { NoteChatSuggestion } from '@/lib/notes/noteChatSuggestions';

const INPUT_KEYBOARD_GAP = 10;

interface NoteChatSheetProps {
  visible: boolean;
  messages: ChatOverNoteMessage[];
  draft: string;
  isProcessing: boolean;
  error: string | null;
  canSend: boolean;
  suggestions: readonly NoteChatSuggestion[];
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onSuggestion: (prompt: string) => void;
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
  suggestions,
  onDraftChange,
  onSend,
  onSuggestion,
  onRetry,
  onClear,
  onClose,
}: NoteChatSheetProps) {
  const insets = useSafeAreaInsets();
  const { copy } = useAndroidCopy();
  const color = useIosColor();
  const { height: windowHeight } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const keyboardHeight = useKeyboardHeight(visible);
  const canSubmit = canSend && draft.trim().length > 0 && !isProcessing;
  const hasMessages = messages.length > 0;
  // Shortcuts only seed the first question: they'd crowd an existing thread, and a tap sends
  // immediately, so they step aside once the user starts typing rather than discard the draft.
  const showSuggestions = !hasMessages && !draft.trim() && suggestions.length > 0;
  const canUseSuggestion = canSend && !isProcessing;
  const isAndroid = Platform.OS === 'android';
  const sheetHeight = Math.min(
    isAndroid && keyboardHeight > 0 ? windowHeight : windowHeight * 0.82,
    windowHeight - insets.top - 8,
  );
  const bottomPad =
    keyboardHeight > 0
      ? // Android reports IME height minus system-bar insets; this edge-to-edge modal
        // must reserve the navigation area too, or the keyboard clips the composer.
        keyboardHeight + (isAndroid ? insets.bottom : 0) + INPUT_KEYBOARD_GAP
      : Math.max(insets.bottom, 14);

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
          accessibilityLabel={copy('noteChat.dismiss', 'Dismiss note chat')}
          onPress={onClose}
          className="absolute inset-0 bg-black/40"
        />
        <View
          className="rounded-t-[28px] px-5 pt-3"
          style={{
            backgroundColor: color('systemBackground'),
            height: sheetHeight,
            paddingBottom: bottomPad,
            borderCurve: 'continuous',
          }}
        >
          <View
            className="mb-2 self-center h-1.5 w-9 rounded-full"
            style={{ backgroundColor: color('quaternaryLabel') }}
          />
          <View className="mb-3 flex-row items-center justify-between">
            <View className="flex-1 pr-3">
              <Text
                accessibilityRole="header"
                className="text-[19px] font-bold"
                style={{ color: color('label') }}
              >
                {copy('editor.askNote', 'Ask about this note')}
              </Text>
              {!isAndroid ? (
                <Text className="mt-1 text-[13px]" style={{ color: color('secondaryLabel') }}>
                  {copy(
                    'noteChat.privacy',
                    "Answers use only this note. This chat is temporary and won't be saved.",
                  )}
                </Text>
              ) : null}
            </View>
            {hasMessages ? (
              <Pressable
                onPress={onClear}
                disabled={isProcessing}
                className="mr-2 px-2 py-1"
                accessibilityRole="button"
                accessibilityLabel={copy('noteChat.clearChat', 'Clear chat')}
              >
                <Text className="text-[14px] font-medium" style={{ color: color('link') }}>
                  {copy('noteChat.clear', 'Clear')}
                </Text>
              </Pressable>
            ) : null}
            <GlassIconButton
              onPress={onClose}
              accessibilityLabel={copy('noteChat.closeChat', 'Close chat')}
              size={30}
            >
              <SystemIcon name="xmark" mdName="X" size={13} color="secondaryLabel" />
            </GlassIconButton>
          </View>

          {/* With the keyboard up the sheet is short, so an empty thread must not squeeze the chips. */}
          <ScrollView
            ref={scrollRef}
            className={`flex-1 ${hasMessages && !isAndroid ? 'min-h-[220px]' : ''}`}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => {
              if (!isAndroid || hasMessages) scrollRef.current?.scrollToEnd({ animated: true });
            }}
          >
            {isAndroid ? (
              <Text className="mb-3 text-[13px]" style={{ color: color('secondaryLabel') }}>
                {copy(
                  'noteChat.privacy',
                  "Answers use only this note. This chat is temporary and won't be saved.",
                )}
              </Text>
            ) : null}
            {hasMessages ? (
              <View className="gap-3 pb-3">
                {messages.map((message) => {
                  const isUser = message.role === 'user';
                  return (
                    <View
                      key={message.id}
                      className={`max-w-[86%] rounded-[18px] px-3 py-2 ${
                        isUser ? 'self-end bg-brand' : 'self-start'
                      }`}
                      style={[
                        { borderCurve: 'continuous' },
                        isUser ? null : { backgroundColor: color('secondarySystemBackground') },
                      ]}
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
                    className="max-w-[86%] self-start rounded-[18px] px-3 py-2"
                    style={{
                      borderCurve: 'continuous',
                      backgroundColor: color('secondarySystemBackground'),
                    }}
                  >
                    <View className="flex-row items-center gap-2">
                      <ActivityIndicator size="small" color={BRAND} />
                      <Text className="text-[14px]" style={{ color: color('secondaryLabel') }}>
                        {copy('noteChat.thinking', 'Thinking...')}
                      </Text>
                    </View>
                  </View>
                ) : null}
              </View>
            ) : null}
          </ScrollView>

          {error ? (
            <View
              className="mb-2 rounded-xl px-3 py-2"
              style={{ backgroundColor: color('tertiarySystemFill') }}
            >
              <Text className="text-[13px]" style={{ color: color('secondaryLabel') }}>
                {error}
              </Text>
              <Pressable
                onPress={onRetry}
                disabled={isProcessing}
                className="mt-1 self-start py-1"
                accessibilityRole="button"
                accessibilityLabel={copy('noteChat.retryQuestion', 'Retry chat question')}
              >
                <Text className="text-[13px] font-semibold" style={{ color: color('link') }}>
                  {copy('noteChat.retryAction', 'Retry')}
                </Text>
              </Pressable>
            </View>
          ) : null}

          {/* Bleeds past the sheet's side padding so chips scroll edge to edge. */}
          {showSuggestions ? (
            <ScrollView
              horizontal
              className="-mx-5 mb-3 shrink-0 grow-0"
              contentContainerClassName="gap-2 px-5"
              keyboardShouldPersistTaps="handled"
              showsHorizontalScrollIndicator={false}
            >
              {suggestions.map((suggestion) => (
                <Pressable
                  key={suggestion.label}
                  onPress={() => onSuggestion(suggestion.prompt)}
                  disabled={!canUseSuggestion}
                  accessibilityRole="button"
                  accessibilityLabel={
                    suggestion.labelKey
                      ? copy(suggestion.labelKey, suggestion.label)
                      : suggestion.label
                  }
                  accessibilityHint={copy('noteChat.sendsQuestion', 'Sends this question')}
                  className="rounded-full px-4 py-2.5 active:opacity-70 disabled:opacity-50"
                  style={{
                    borderCurve: 'continuous',
                    backgroundColor: color('tertiarySystemFill'),
                  }}
                >
                  <Text className="text-[15px] font-medium" style={{ color: color('label') }}>
                    {suggestion.labelKey
                      ? copy(suggestion.labelKey, suggestion.label)
                      : suggestion.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}

          <View
            className="flex-row items-end gap-2 rounded-[22px] px-3 py-2"
            style={{ backgroundColor: color('secondarySystemBackground') }}
          >
            <TextInput
              value={draft}
              onChangeText={onDraftChange}
              placeholder={
                canSend
                  ? copy('noteChat.questionPlaceholder', 'Ask a question...')
                  : copy('noteChat.noContent', 'No note content to ask about')
              }
              placeholderTextColor={color('tertiaryLabel')}
              multiline
              editable={canSend && !isProcessing}
              className="max-h-[110px] flex-1 py-1 text-[16px] leading-5"
              style={{ color: color('label') }}
              textAlignVertical="top"
            />
            <Pressable
              onPress={onSend}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityLabel={copy('noteChat.sendQuestion', 'Send question')}
              className={`${Platform.OS === 'android' ? 'h-12 w-12' : 'h-9 w-9'} items-center justify-center rounded-full ${
                canSubmit ? 'bg-brand' : ''
              }`}
              style={canSubmit ? undefined : { backgroundColor: color('tertiarySystemFill') }}
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
