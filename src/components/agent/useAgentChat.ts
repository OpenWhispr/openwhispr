import { useCallback, useRef, useState } from "react";
import { useChatPersistence } from "../chat/useChatPersistence";
import { useChatStreaming } from "../chat/useChatStreaming";
import { useChatMessageSender } from "../chat/useChatMessageSender";
import { useInterruptedInteractions } from "../chat/useInterruptedInteractions";
import type { SendToAIOptions } from "../chat/useChatStreaming";
import type { Message } from "../chat/types";

const conversationTitle = (text: string) => (text.length > 50 ? `${text.slice(0, 50)}...` : text);

/**
 * The agent window's running chat: the agent chat's persistence, streaming
 * and sender on the Voice Assistant scope, with connectors and interactions.
 * New chat, switching, forking and regenerating all end the running turn first,
 * since one stream runs per window.
 */
export function useAgentChat({
  onRegenerateFailed,
}: {
  /** A regenerate failed before anything new; the old reply is back. */
  onRegenerateFailed: () => void;
}) {
  const persistence = useChatPersistence();
  const streaming = useChatStreaming({
    setMessages: persistence.setMessages,
    inferenceScope: "dictationAgent",
    allowConnectors: true,
    allowInteractions: true,
    onStreamComplete: persistence.saveAssistantMessage,
    onTurnCheckpoint: persistence.saveAssistantMessage,
  });
  const { cancelStream, sendToAI } = streaming;
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  const { createConversation: createPersisted, forkOrigin } = persistence;
  const createConversation = useCallback(
    (text: string) => createPersisted(conversationTitle(text)),
    [createPersisted]
  );
  const sendMessage = useChatMessageSender({
    conversationId: persistence.conversationId,
    persistence,
    streaming,
    createConversation,
    onSendingChange: setSubmissionInFlight,
  });
  // An answer to a card left from an earlier turn goes on as a message of the app's.
  useInterruptedInteractions(persistence, sendMessage);

  // Read through a ref, so these stay the same while a reply streams.
  const messagesRef = useRef(persistence.messages);
  messagesRef.current = persistence.messages;
  const busy = submissionInFlight || streaming.agentState !== "idle";
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const { loadConversation, handleNewChat, forkConversation, conversationId } = persistence;

  // A message the user wrote. A fork starts with its parent's title; the first
  // one written in it names it, as a new chat's does, unless it was renamed.
  const send = useCallback(
    (text: string, options?: SendToAIOptions) => {
      if (
        forkOrigin &&
        conversationId != null &&
        forkOrigin.title === forkOrigin.parentTitle &&
        messagesRef.current.length === forkOrigin.copiedMessageCount
      ) {
        void window.electronAPI?.updateAgentConversationTitle?.(
          conversationId,
          conversationTitle(text)
        );
      }
      return sendMessage(text, options);
    },
    [conversationId, forkOrigin, sendMessage]
  );

  const switchChat = useCallback(
    async (id: number) => {
      cancelStream();
      return loadConversation(id);
    },
    [cancelStream, loadConversation]
  );

  const newChat = useCallback(() => {
    cancelStream();
    handleNewChat();
  }, [cancelStream, handleNewChat]);

  const fork = useCallback(
    (message: Message, selectedText?: string) => {
      cancelStream();
      return forkConversation(message, selectedText);
    },
    [cancelStream, forkConversation]
  );

  // The latest reply, answered again from the same request and history. It
  // replaces the reply in place and keeps the sends that reply made, so the
  // duplicate-send guard still sees them. A screenshot isn't saved, so the
  // regenerated answer has none.
  const regenerate = useCallback(
    (message: Message) => {
      const messages = messagesRef.current;
      const index = messages.findIndex((m) => m.id === message.id);
      const request = messages
        .slice(0, index)
        .reverse()
        .find((m) => m.role === "user");
      if (busyRef.current || index !== messages.length - 1 || !request || conversationId == null) {
        return;
      }
      busyRef.current = true;
      void sendToAI(request.content, messages.slice(0, index), {
        conversationId,
        replaceMessage: messages[index],
        onReplaceFailed: onRegenerateFailed,
      });
    },
    [conversationId, onRegenerateFailed, sendToAI]
  );

  return {
    messages: persistence.messages,
    conversationId,
    forkOrigin,
    agentState: streaming.agentState,
    busy,
    send,
    cancel: cancelStream,
    switchChat,
    newChat,
    fork,
    regenerate,
  };
}
