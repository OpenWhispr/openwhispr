import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Keyboard, ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TabScreenHeader } from '@/components/ui/TabScreenHeader';
import { GlassBackButton } from '@/components/ui/GlassBackButton';
import { ChatAssistantMessage } from '@/components/chat/ChatAssistantMessage';
import { ChatComposerNotice } from '@/components/chat/ChatComposerNotice';
import { ChatErrorRow } from '@/components/chat/ChatErrorRow';
import { ChatInputBar } from '@/components/chat/ChatInputBar';
import { ChatSteps } from '@/components/chat/ChatSteps';
import { ChatTranscribingBubble } from '@/components/chat/ChatTranscribingBubble';
import { ChatUserBubble } from '@/components/chat/ChatUserBubble';
import { ChatWatermark } from '@/components/chat/ChatWatermark';
import { useChatSendGate } from '@/hooks/useChatSendGate';
import { useChatVoiceInput } from '@/hooks/useChatVoiceInput';
import { chatTabGateOptions } from '@/lib/chat/chatConsent';
import { withSpokenQuestion } from '@/lib/chat/chatDraft';
import {
  ownsChatPending,
  SEND_BLOCKED_NOTICE,
  selectPendingTitle,
  workingElsewhereLabel,
} from '@/lib/chat/chatPending';
import {
  CHAT_HOME_ROUTE,
  CHAT_SETTINGS_ROUTE,
  chatConversationRoute,
  chatNoteRoute,
  NEW_CHAT_ID,
} from '@/lib/chat/chatRoutes';
import type { ChatConversationSummary, ChatMessage } from '@/lib/chat/types';
import { useChatStore } from '@/store/useChatStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';

// How close to the end counts as reading the latest message, so new content keeps it in view.
const NEAR_BOTTOM_PX = 80;

const isListed = (conversations: ChatConversationSummary[], id: string): boolean =>
  conversations.some((conversation) => conversation.id === id);

export function ChatConversationScreen(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversationId = id && id !== NEW_CHAT_ID ? id : null;
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [draft, setDraft] = useState('');
  const focusedRef = useRef(false);
  const nearBottomRef = useRef(true);
  const wasWorkingRef = useRef(false);
  // Set once rows have been shown, so only later growth animates the scroll to the end.
  const settledRef = useRef(false);

  const openMessages = useChatStore((s) =>
    s.activeConversationId === conversationId ? s.messages : null,
  );
  const listed = useChatStore(
    (s) => conversationId !== null && isListed(s.conversations, conversationId),
  );
  // The store holds the open chat's messages only, so a chat pushed over this one takes them; this
  // screen keeps its own rows while its chat is listed, and a swipe back never shows the other
  // chat. A chat deleted or wiped with its account takes its rows with it.
  const keptRowsRef = useRef<ChatMessage[]>([]);
  if (openMessages) keptRowsRef.current = openMessages;
  else if (!listed) keptRowsRef.current = [];
  const messages = keptRowsRef.current;
  const pending = useChatStore((s) => s.pending);
  const failureHere = useChatStore((s) =>
    conversationId ? s.failures[conversationId] : undefined,
  );
  const title = useChatStore(
    (s) => s.conversations.find((conversation) => conversation.id === conversationId)?.title,
  );
  const pendingTitle = useChatStore(selectPendingTitle);
  const sendBlocked = useChatStore((s) => s.sendBlockedByWipe);
  const activeMode = useProcessingModeStore((s) => s.activeMode);
  const { chatEnabled, gate } = useChatSendGate();
  const isFocused = useCallback((): boolean => focusedRef.current, []);

  // router.setParams acts on whichever screen is focused, so a popped or covered new chat whose
  // spoken question lands late must leave it alone.
  const adoptConversation = useCallback(
    (newId: string): void => {
      if (!conversationId && focusedRef.current) router.setParams({ id: newId });
    },
    [conversationId],
  );
  const voice = useChatVoiceInput({
    conversationId,
    onSent: adoptConversation,
    onNotSent: (text) => setDraft((current) => withSpokenQuestion(current, text)),
    isFocused,
  });
  const voiceRef = useRef(voice);
  voiceRef.current = voice;

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      const store = useChatStore.getState();
      store.loadConversations();
      if (conversationId) {
        // A chat deleted, or wiped with its account, while this screen was covered.
        if (isListed(useChatStore.getState().conversations, conversationId)) {
          store.openConversation(conversationId);
        } else {
          router.setParams({ id: NEW_CHAT_ID });
        }
      }
      return () => {
        focusedRef.current = false;
        // A question still being spoken is dropped; one already transcribing may still send.
        if (voiceRef.current.state === 'listening')
          voiceRef.current.cancel().catch(() => undefined);
      };
    }, [conversationId]),
  );

  // A chat that goes while it's showing leaves a new chat, so the composer still works. The store is
  // read afresh, since on mount the focus effect has only just loaded the list.
  useEffect(() => {
    if (
      conversationId &&
      !listed &&
      focusedRef.current &&
      !isListed(useChatStore.getState().conversations, conversationId)
    ) {
      router.setParams({ id: NEW_CHAT_ID });
    }
  }, [conversationId, listed]);

  // Closed only once this chat goes away, since a note or chat pushed over it leaves it underneath.
  // A chat opened over this one has already taken its place, so only this one is closed.
  useEffect(
    () => () => useChatStore.getState().closeConversation(conversationId),
    [conversationId],
  );

  // The bar's padding grows with the keyboard, which shrinks the list without changing its content.
  // A keyboard opened on another screen leaves a covered chat where it was.
  useEffect(() => {
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      if (focusedRef.current) scrollRef.current?.scrollToEnd({ animated: true });
    });
    return () => subscription.remove();
  }, []);

  const pendingHere = ownsChatPending(pending, conversationId, voice.state) ? pending : null;
  // One turn runs at a time across every chat, so a turn elsewhere locks this composer too.
  const busy = pending !== null || voice.state === 'transcribing';
  const gateOptions = chatTabGateOptions(activeMode);
  const workingHere = pendingHere?.phase === 'working';
  const lastMessage = messages.at(-1);

  // A new message or a change of phase always brings the end into view.
  useEffect(() => {
    nearBottomRef.current = true;
  }, [messages.length, pendingHere?.phase, failureHere]);

  // The answer and the error arrive out of sight of a screen reader, so they're announced, but
  // only by the chat on screen.
  useEffect(() => {
    if (wasWorkingRef.current && !workingHere && focusedRef.current) {
      if (failureHere) {
        AccessibilityInfo.announceForAccessibility(
          `Couldn’t get an answer. ${failureHere.message}`,
        );
      } else if (lastMessage?.role === 'assistant') {
        AccessibilityInfo.announceForAccessibility('Answer ready.');
      }
    }
    wasWorkingRef.current = workingHere;
  }, [workingHere, failureHere, lastMessage]);

  // The notice appears beside the composer, out of a screen reader's sight, so the screen on show
  // reads it out.
  useEffect(() => {
    if (sendBlocked && focusedRef.current) {
      AccessibilityInfo.announceForAccessibility(SEND_BLOCKED_NOTICE);
    }
  }, [sendBlocked]);

  const handleSend = (): void => {
    const question = draft.trim();
    if (!question || busy) return;
    gate((allowCloudFallback) => {
      const result = useChatStore.getState().send(question, { conversationId, allowCloudFallback });
      if (!result) return;
      setDraft('');
      adoptConversation(result.conversationId);
    }, gateOptions);
  };

  const errorActionsDisabled = !chatEnabled || busy || voice.state !== 'idle';

  const handleRetry = (): void => {
    if (!conversationId || errorActionsDisabled) return;
    gate((allowCloudFallback) => {
      useChatStore
        .getState()
        .retry(conversationId, { allowCloudFallback })
        .catch(() => undefined);
    }, gateOptions);
  };

  const handleEditQuestion = (): void => {
    // A question still being spoken belongs to this chat, which the edit may delete.
    if (!conversationId || voice.state !== 'idle') return;
    // Editing the only question deletes the chat, which leaves a new chat for the next send.
    const question = useChatStore.getState().editFailedQuestion(conversationId);
    if (question !== null) setDraft(question);
  };

  const openNote = (noteId: number): void => {
    // Leaving mid-question would drop what's being said.
    if (voiceRef.current.state !== 'idle') return;
    router.push(chatNoteRoute(noteId));
  };

  // A turn in another chat locks this composer without offering to stop it.
  const workingId = pending?.conversationId ?? null;
  const composerNotice = !chatEnabled ? (
    <ChatComposerNotice
      label="Chat is turned off"
      onPress={() => router.push(CHAT_SETTINGS_ROUTE)}
    />
  ) : pending && !pendingHere ? (
    <ChatComposerNotice
      label={workingElsewhereLabel(pendingTitle)}
      onPress={workingId ? () => router.push(chatConversationRoute(workingId)) : undefined}
    />
  ) : sendBlocked ? (
    <ChatComposerNotice label={SEND_BLOCKED_NOTICE} />
  ) : null;

  return (
    <View className="flex-1 bg-systemBackground">
      <ChatWatermark />
      <TabScreenHeader
        title={title ?? 'New chat'}
        left={<GlassBackButton fallbackRoute={CHAT_HOME_ROUTE} />}
      />

      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerStyle={styles.messages}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={100}
        onScroll={({ nativeEvent }) => {
          nearBottomRef.current =
            nativeEvent.contentOffset.y + nativeEvent.layoutMeasurement.height >=
            nativeEvent.contentSize.height - NEAR_BOTTOM_PX;
        }}
        // Opening an earlier answer's steps grows the content too, which mustn't pull the reader
        // away from it. A chat opening lands on its end at once; animating would sweep through a
        // long one.
        onContentSizeChange={() => {
          if (!nearBottomRef.current) return;
          scrollRef.current?.scrollToEnd({ animated: settledRef.current });
          if (messages.length > 0) settledRef.current = true;
        }}
      >
        {messages.map((message) =>
          message.role === 'user' ? (
            <ChatUserBubble key={message.id} text={message.text} />
          ) : (
            <ChatAssistantMessage key={message.id} message={message} onOpenNote={openNote} />
          ),
        )}
        {pendingHere?.phase === 'transcribing' ? (
          <ChatTranscribingBubble elapsedSeconds={voice.elapsedSeconds} />
        ) : null}
        {pendingHere?.phase === 'working' ? (
          <ChatSteps
            steps={pendingHere.steps}
            variant="working"
            startedAt={pendingHere.startedAt}
            isFocused={isFocused}
          />
        ) : null}
        {failureHere ? (
          <ChatErrorRow
            message={failureHere.message}
            disabled={errorActionsDisabled}
            onRetry={handleRetry}
            onEdit={handleEditQuestion}
          />
        ) : null}
      </ScrollView>

      <ChatInputBar
        voice={voice}
        value={draft}
        onChangeText={setDraft}
        placeholder={conversationId ? 'Reply' : 'Ask anything'}
        busy={busy}
        canStop={pendingHere !== null || voice.state === 'transcribing'}
        disabled={!chatEnabled}
        onSend={handleSend}
        onMicPress={(startVoice) => {
          if (!busy) gate(startVoice, gateOptions);
        }}
        onCancelTurn={() => useChatStore.getState().cancel()}
        restingBottomPadding={Math.max(insets.bottom, 14)}
        notice={composerNotice}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  messages: { flexGrow: 1, justifyContent: 'flex-end', padding: 16, gap: 16 },
});
