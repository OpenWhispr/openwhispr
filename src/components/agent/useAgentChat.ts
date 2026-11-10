import { useCallback, useRef, useState } from "react";
import { useChatPersistence } from "../chat/useChatPersistence";
import { useChatStreaming } from "../chat/useChatStreaming";
import { useChatMessageSender } from "../chat/useChatMessageSender";
import { useInterruptedInteractions } from "../chat/useInterruptedInteractions";
import type { SendToAIOptions } from "../chat/useChatStreaming";
import type { Message } from "../chat/types";

const noop = () => {};
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
  // The send in flight, so a spoken turn can wait for a stopped one to let go.
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const settled = useCallback(
    (): Promise<void> => inFlightRef.current?.then(noop, noop) ?? Promise.resolve(),
    []
  );
  const track = useCallback((sending: Promise<boolean>): Promise<boolean> => {
    inFlightRef.current = sending;
    void sending
      .finally(() => {
        if (inFlightRef.current === sending) inFlightRef.current = null;
      })
      .catch(noop);
    return sending;
  }, []);
  // An answer to a card left from an earlier turn goes on as a message of the app's.
  const sendWithSkill = useCallback(
    (text: string, options?: SendToAIOptions) =>
      track(sendMessage(text, { ...options, ...skillSendOptions() })),
    [sendMessage, skillSendOptions, track]
  );
  useInterruptedInteractions(persistence, sendWithSkill);

  // Read through a ref, so these stay the same while a reply streams.
  const messagesRef = useRef(persistence.messages);
  messagesRef.current = persistence.messages;
  const busy = submissionInFlight || streaming.agentState !== "idle";
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const regenerationRef = useRef<{ sessionVersion: number } | null>(null);

  const {
    loadConversation,
    handleNewChat,
    forkConversation,
    conversationId,
    getSessionVersion,
    setMessages,
  } = persistence;

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

  // A spoken request a pause cut short, said whole. While its first half is
  // still the last request, that request is rewritten and its reply (if it
  // had one yet) answered again in place, as a regenerate does, so the chat
  // and its history hold the request once; otherwise it is sent as it is.
  const sendJoined = useCallback(
    (requestText: string, options?: SendToAIOptions): Promise<boolean> => {
      const messages = messagesRef.current;
      const replied = messages.at(-1)?.role === "assistant";
      const reply = replied ? messages.at(-1) : undefined;
      const request = messages.at(replied ? -2 : -1);
      if (
        request?.role !== "user" ||
        !requestText.startsWith(`${request.content} `) ||
        conversationId == null
      ) {
        return send(requestText, options);
      }
      const joined: Message = { ...request, content: requestText };
      setMessages((prev) => prev.map((m) => (m.id === request.id ? joined : m)));
      if (request.dbId != null) {
        const { selectedContext, selectedContextSource } = request;
        void window.electronAPI
          ?.updateAgentMessage?.(
            request.dbId,
            requestText,
            selectedContext
              ? { selectedContext, ...(selectedContextSource ? { selectedContextSource } : {}) }
              : undefined
          )
          .catch(noop);
      }
      return track(
        sendToAI(requestText, [...messages.slice(0, replied ? -2 : -1), joined], {
          ...skillSendOptions(),
          ...options,
          conversationId,
          replaceMessage: reply,
        }).then(() => true)
      );
    },
    [conversationId, send, sendToAI, setMessages, skillSendOptions, track]
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
    sendJoined,
    settled,
    cancel: cancelStream,
    switchChat,
    newChat,
    fork,
    regenerate,
  };
}
