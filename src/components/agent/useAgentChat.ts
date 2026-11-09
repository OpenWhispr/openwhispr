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
  const [pickedSkill, setPickedSkill] = useState<{ name: string; displayName: string } | null>(
    null
  );
  const [skillPickOff, setSkillPickOff] = useState(false);
  const removePickedSkill = useCallback(() => {
    setPickedSkill(null);
    setSkillPickOff(true);
  }, []);
  const skillSendOptions = useCallback(
    (): SendToAIOptions => ({
      attachedSkill: pickedSkill ? { name: pickedSkill.name } : undefined,
      allowSkillPick: !skillPickOff,
      onSkillPicked: setPickedSkill,
    }),
    [pickedSkill, skillPickOff]
  );
  const streaming = useChatStreaming({
    setMessages: persistence.setMessages,
    inferenceScope: "dictationAgent",
    allowConnectors: true,
    allowInteractions: true,
    skillsEnabled: true,
    onStreamComplete: persistence.saveAssistantMessage,
    claimConversation: persistence.claimConversation,
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
  const sendWithSkill = useCallback(
    (text: string, options?: SendToAIOptions) =>
      sendMessage(text, { ...options, ...skillSendOptions() }),
    [sendMessage, skillSendOptions]
  );
  useInterruptedInteractions(persistence, sendWithSkill);

  // Read through a ref, so these stay the same while a reply streams.
  const messagesRef = useRef(persistence.messages);
  messagesRef.current = persistence.messages;
  const busy = submissionInFlight || streaming.agentState !== "idle";
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const regenerationRef = useRef<{ sessionVersion: number } | null>(null);

  const { loadConversation, handleNewChat, forkConversation, conversationId, getSessionVersion } =
    persistence;

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
      return sendWithSkill(text, options);
    },
    [conversationId, forkOrigin, sendWithSkill]
  );

  const switchChat = useCallback(
    (id: number, beforeOpen?: () => void) =>
      loadConversation(id, () => {
        cancelStream();
        setPickedSkill(null);
        setSkillPickOff(false);
        beforeOpen?.();
      }),
    [cancelStream, loadConversation]
  );

  const newChat = useCallback(() => {
    cancelStream();
    handleNewChat();
    setPickedSkill(null);
    setSkillPickOff(false);
  }, [cancelStream, handleNewChat]);

  const fork = useCallback(
    (message: Message, selectedText?: string, beforeOpen?: () => void) => {
      return forkConversation(message, selectedText, () => {
        cancelStream();
        beforeOpen?.();
      });
    },
    [cancelStream, forkConversation]
  );

  // The latest reply, answered again from the same request and history. It
  // replaces the reply in place and keeps the sends that reply made, so the
  // duplicate-send guard still sees them. A screenshot isn't saved, so the
  // regenerated answer has none.
  const regenerate = useCallback(
    async (message: Message): Promise<void> => {
      const sessionVersion = getSessionVersion();
      const messages = messagesRef.current;
      const index = messages.findIndex((m) => m.id === message.id);
      const request = messages
        .slice(0, index)
        .reverse()
        .find((m) => m.role === "user");
      if (
        busyRef.current ||
        regenerationRef.current?.sessionVersion === sessionVersion ||
        index !== messages.length - 1 ||
        !request ||
        conversationId == null
      ) {
        return;
      }
      // Claiming can finish without a render; keep its lock separate from busy.
      const regeneration = { sessionVersion };
      regenerationRef.current = regeneration;
      const reportFailure = (): void => {
        if (regenerationRef.current === regeneration && sessionVersion === getSessionVersion())
          onRegenerateFailed();
      };
      try {
        await sendToAI(request.content, messages.slice(0, index), {
          ...skillSendOptions(),
          conversationId,
          replaceMessage: messages[index],
          onReplaceFailed: reportFailure,
        });
      } catch {
        reportFailure();
      } finally {
        if (regenerationRef.current === regeneration) regenerationRef.current = null;
      }
    },
    [conversationId, getSessionVersion, onRegenerateFailed, sendToAI, skillSendOptions]
  );

  return {
    messages: persistence.messages,
    pickedSkill,
    removePickedSkill,
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
