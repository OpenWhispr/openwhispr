import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, Pressable, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { TabScreenHeader } from '@/components/ui/TabScreenHeader';
import { GlassIconButton } from '@/components/ui/GlassIconButton';
import { ChatComposerNotice } from '@/components/chat/ChatComposerNotice';
import { ChatInputBar } from '@/components/chat/ChatInputBar';
import { ChatSuggestionChips } from '@/components/chat/ChatSuggestionChips';
import { ChatTurnedOff } from '@/components/chat/ChatTurnedOff';
import { TAB_BAR_CLEARANCE } from '@/components/ui/tabBarClearance';
import { calendarRepository } from '@/data';
import { useChatSendGate } from '@/hooks/useChatSendGate';
import { useChatVoiceInput } from '@/hooks/useChatVoiceInput';
import { getAccountFirstName } from '@/lib/accountDisplay';
import { getMeetingCalendarEventSuggestions } from '@/lib/calendar/meetingSuggestions';
import { chatTabGateOptions } from '@/lib/chat/chatConsent';
import { withSpokenQuestion } from '@/lib/chat/chatDraft';
import {
  SEND_BLOCKED_NOTICE,
  selectPendingTitle,
  workingElsewhereLabel,
} from '@/lib/chat/chatPending';
import {
  CHAT_HISTORY_ROUTE,
  CHAT_SETTINGS_ROUTE,
  chatConversationRoute,
} from '@/lib/chat/chatRoutes';
import { buildChatSuggestions, type ChatSuggestion } from '@/lib/chat/chatSuggestions';
import { useAuthStore } from '@/store/useAuthStore';
import { useChatStore } from '@/store/useChatStore';
import { useGoogleCalendarStore } from '@/store/useGoogleCalendarStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';

// Enough that a running meeting or a day of all-day events can't hide the next meeting worth
// prepping.
const SUGGESTION_EVENT_POOL = 50;

const loadSuggestions = (): ChatSuggestion[] => {
  const now = new Date();
  const { accounts } = useGoogleCalendarStore.getState();
  const events = getMeetingCalendarEventSuggestions(
    accounts,
    calendarRepository,
    now,
    SUGGESTION_EVENT_POOL,
  );
  return buildChatSuggestions({ events, now });
};

const pushConversation = (conversationId: string): void => {
  router.push(chatConversationRoute(conversationId));
};

export function ChatHomeScreen(): React.JSX.Element {
  const [draft, setDraft] = useState('');
  // Read up front, so a meeting to prep for doesn't shift the row in after the first frame.
  const [suggestions, setSuggestions] = useState(loadSuggestions);
  const focusedRef = useRef(false);

  const pending = useChatStore((s) => s.pending);
  const pendingTitle = useChatStore(selectPendingTitle);
  const sendBlocked = useChatStore((s) => s.sendBlockedByWipe);
  const firstName = useAuthStore((s) => getAccountFirstName(s.user));
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const { chatEnabled, gate } = useChatSendGate();
  const voice = useChatVoiceInput({
    conversationId: null,
    // A question still transcribing when Home lost focus is sent, but doesn't pull the user back.
    onSent: (conversationId) => {
      if (focusedRef.current) pushConversation(conversationId);
    },
    onNotSent: (text) => setDraft((current) => withSpokenQuestion(current, text)),
    isFocused: () => focusedRef.current,
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  useFocusEffect(
    useCallback(() => {
      let focused = true;
      focusedRef.current = true;
      const refresh = (): void => {
        if (focused) setSuggestions(loadSuggestions());
      };
      useChatStore.getState().loadConversations();
      refresh();
      // Loading also refreshes the calendar accounts runChatTurn reads.
      useGoogleCalendarStore
        .getState()
        .load()
        .catch(() => undefined)
        .then(refresh);
      return () => {
        focused = false;
        focusedRef.current = false;
        if (voiceRef.current.state === 'listening')
          voiceRef.current.cancel().catch(() => undefined);
      };
    }, []),
  );

  // The notice appears beside the composer, out of a screen reader's sight, so the screen on show
  // reads it out.
  useEffect(() => {
    if (sendBlocked && focusedRef.current) {
      AccessibilityInfo.announceForAccessibility(SEND_BLOCKED_NOTICE);
    }
  }, [sendBlocked]);

  // One turn runs at a time across every chat, so any pending turn locks Home too. Home is no
  // conversation, so the only thing it can stop is its own spoken question.
  const transcribingHere = voice.state === 'transcribing';
  const busy = pending !== null || transcribingHere;
  const workingId = pending?.conversationId ?? null;
  // Home's own spoken question says it's transcribing in the composer.
  const composerNotice =
    pending && !transcribingHere ? (
      <ChatComposerNotice
        label={workingElsewhereLabel(pendingTitle)}
        onPress={workingId ? () => pushConversation(workingId) : undefined}
      />
    ) : sendBlocked ? (
      <ChatComposerNotice label={SEND_BLOCKED_NOTICE} />
    ) : null;
  const gateOptions = chatTabGateOptions(activeMode);
  // Leaving Home, or asking something else, while a question is being spoken would drop it.
  const runIfVoiceIdle = (action: () => void): void => {
    if (voiceRef.current.state === 'idle') action();
  };

  const ask = (question: string, clearDraft: boolean): void => {
    if (!question.trim() || busy) return;
    gate((allowCloudFallback) => {
      const result = useChatStore
        .getState()
        .send(question, { conversationId: null, allowCloudFallback });
      if (!result) return;
      if (clearDraft) setDraft('');
      pushConversation(result.conversationId);
    }, gateOptions);
  };

  return (
    <View className="flex-1 bg-systemBackground">
      <TabScreenHeader
        title="Chat"
        right={
          <GlassIconButton
            accessibilityLabel="All chats"
            onPress={() => runIfVoiceIdle(() => router.push(CHAT_HISTORY_ROUTE))}
          >
            <SystemIcon name="clock.arrow.circlepath" mdName="History" size={18} color="brand" />
          </GlassIconButton>
        }
      />

      {chatEnabled ? (
        <>
          {/* Tapping the open space puts the keyboard away. */}
          <Pressable
            accessible={false}
            onPress={Keyboard.dismiss}
            className="flex-1 items-center justify-center px-8"
          >
            <Text
              accessibilityRole="header"
              className="text-center text-[30px] leading-[36px] text-label"
            >
              {firstName ? `Hi ${firstName}, ask anything` : 'Ask anything'}
            </Text>
          </Pressable>

          <ChatInputBar
            voice={voice}
            value={draft}
            onChangeText={setDraft}
            placeholder="Summarize my meetings this week"
            inputLabel="Ask anything"
            tall
            busy={busy}
            canStop={transcribingHere}
            disabled={false}
            onSend={() => ask(draft, true)}
            onMicPress={(startVoice) => {
              if (!busy) gate(startVoice, gateOptions);
            }}
            onCancelTurn={() => useChatStore.getState().cancel()}
            restingBottomPadding={TAB_BAR_CLEARANCE}
            accessory={
              <ChatSuggestionChips
                suggestions={suggestions}
                disabled={busy || voice.state !== 'idle'}
                onPress={(suggestion) => runIfVoiceIdle(() => ask(suggestion.prompt, false))}
              />
            }
            notice={composerNotice}
          />
        </>
      ) : (
        <ChatTurnedOff onOpenSettings={() => router.push(CHAT_SETTINGS_ROUTE)} />
      )}
    </View>
  );
}
