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
    onTurnCheckpoint: persistence.saveAssistantMessage,
  });
  const { cancelStream, sendToAI } = streaming;
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  const { createConversation: createPersisted } = persistence;
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
  const send = useCallback(
    (text: string, options?: SendToAIOptions) =>
      sendMessage(text, { ...options, ...skillSendOptions() }),
    [sendMessage, skillSendOptions]
  );
  useInterruptedInteractions(persistence, send);

  // Read through a ref, so these stay the same while a reply streams.
  const messagesRef = useRef(persistence.messages);
  messagesRef.current = persistence.messages;
  const busy = submissionInFlight || streaming.agentState !== "idle";
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const { loadConversation, handleNewChat, forkConversation, conversationId } = persistence;

  const switchChat = useCallback(
    async (id: number) => {
      cancelStream();
      const conversation = await loadConversation(id);
      if (conversation) {
        setPickedSkill(null);
        setSkillPickOff(false);
      }
      return conversation;
    },
    [cancelStream, loadConversation]
  );

  const newChat = useCallback(() => {
    cancelStream();
    handleNewChat();
    setPickedSkill(null);
    setSkillPickOff(false);
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
        ...skillSendOptions(),
        conversationId,
        replaceMessage: messages[index],
        onReplaceFailed: onRegenerateFailed,
      });
    },
    [conversationId, onRegenerateFailed, sendToAI, skillSendOptions]
  );

  return {
    messages: persistence.messages,
    pickedSkill,
    removePickedSkill,
    conversationId,
    forkOrigin: persistence.forkOrigin,
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
