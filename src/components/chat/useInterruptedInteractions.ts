import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  forgetInteraction,
  pruneInteractions,
  restoreInteraction,
  takeGrantedImage,
  useAgentInteractionStore,
} from "../../stores/agentInteractionStore";
import { approvalKey } from "../../stores/connectorApprovalStore";
import { CONNECTION_TARGET_NAMES } from "../../config/agentCapabilities";
import type { InteractionPayload, InteractionResult } from "../../types/agentInteractions";
import type { ChatPersistence } from "./useChatPersistence";
import type { SendToAIOptions } from "./useChatStreaming";
import { answerText } from "../../utils/interactionAnswers";
import logger from "../../utils/logger";

// The request that continues the task: what the user answered, as they would
// say it. A dismissal starts no turn.
function followUpText(
  payload: InteractionPayload,
  result: InteractionResult,
  t: TFunction
): string | null {
  switch (result.status) {
    case "answered":
      if (payload.kind !== "questions") return null;
      return payload.questions
        .map((question) => answerText(question, result.answers[question.id]))
        .join("\n\n");
    case "connected":
      return t("agentMode.interactions.followUp.connected", {
        name: CONNECTION_TARGET_NAMES[result.target],
      });
    case "granted":
      return t("agentMode.interactions.followUp.granted");
    case "saved":
      return payload.kind === "apiKey"
        ? t("agentMode.interactions.followUp.saved", { provider: payload.providerName })
        : null;
    case "done":
      return t("agentMode.interactions.followUp.done");
    default:
      return null;
  }
}

/**
 * Interactions whose turn ended before the user answered (the app closed, or
 * the chat went away) stay answerable while their reply is the last message.
 * An answer is recorded on the saved reply and continues the task in a new
 * turn, which sees the question and the answer; nothing the turn already did
 * runs again. Once the conversation moves on or closes they are taken away
 * unanswered, and the model sees them as never answered.
 */
export function useInterruptedInteractions(
  persistence: ChatPersistence,
  send: (text: string, options?: SendToAIOptions) => Promise<boolean>
): void {
  const { t } = useTranslation();
  const {
    messages,
    setMessages,
    saveAssistantMessage,
    conversationId,
    getSessionVersion,
    releaseConversation,
  } = persistence;
  // An answer can come minutes after the restore (a connect), so it reads
  // the conversation as it is then.
  const latestRef = useRef({ messages, t });
  latestRef.current = { messages, t };
  const restoredRef = useRef(new Set<string>());
  const followUpRef = useRef<{
    text: string;
    messageId: string;
    version: number | undefined;
    pending: number;
    options?: SendToAIOptions;
  } | null>(null);

  useEffect(() => {
    const version = getSessionVersion?.();
    const continueTask = async (
      messageId: string,
      toolCallId: string,
      payload: InteractionPayload,
      result: InteractionResult
    ) => {
      const image = takeGrantedImage(approvalKey(messageId, toolCallId));
      if (version !== getSessionVersion?.()) return;
      const latest = latestRef.current;
      const message = latest.messages.find((m) => m.id === messageId);
      if (!message) return;
      const toolCalls = message.toolCalls?.map((call) =>
        call.id === toolCallId
          ? { ...call, interaction: { payload, state: "settled" as const, result } }
          : call
      );
      latestRef.current = {
        ...latest,
        messages: latest.messages.map((m) => (m.id === messageId ? { ...m, toolCalls } : m)),
      };
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, toolCalls } : m)));
      const text = followUpText(payload, result, latest.t);
      const followUp: NonNullable<typeof followUpRef.current> =
        followUpRef.current?.messageId === messageId && followUpRef.current.version === version
          ? followUpRef.current
          : { text: "", messageId, version, pending: 0 };
      if (text) followUp.text = [followUp.text, text].filter(Boolean).join("\n\n");
      if (image) followUp.options = { attachment: image };
      followUp.pending += 1;
      followUpRef.current = followUp;
      try {
        await saveAssistantMessage(messageId, message.content, toolCalls, {
          turn: message.turn,
          ...(conversationId != null ? { conversationId } : {}),
        });
      } catch (error) {
        if (followUpRef.current === followUp) followUpRef.current = null;
        logger.warn("Unable to save restored answer", { error }, "chat");
        if (conversationId != null && version === getSessionVersion?.())
          void releaseConversation?.(conversationId);
        return;
      }
      if (
        followUpRef.current !== followUp ||
        version !== getSessionVersion?.() ||
        !latestRef.current.messages.some((m) => m.id === messageId)
      ) {
        if (followUpRef.current === followUp) followUpRef.current = null;
        return;
      }
      followUp.pending -= 1;
      if (followUp.pending !== 0) return;
      if (followUp.text) {
        setMessages((prev) => [...prev]);
      } else if (conversationId != null) releaseConversation?.(conversationId);
    };

    const restored = restoredRef.current;
    const last = messages.at(-1);
    const current = new Set<string>();
    if (last) {
      // Calls that shared one connect card come back as one card.
      const connections = new Set<string>();
      for (const call of last.toolCalls ?? []) {
        if (call.interaction?.state !== "interrupted") continue;
        const { payload } = call.interaction;
        if (payload.kind === "connection") {
          if (connections.has(payload.target)) continue;
          connections.add(payload.target);
        }
        const key = approvalKey(last.id, call.id);
        current.add(key);
        if (restored.has(key)) continue;
        const request = { messageId: last.id, toolCallId: call.id, payload };
        const opened = restoreInteraction(
          request,
          (result) =>
            void continueTask(request.messageId, request.toolCallId, request.payload, result)
        );
        if (opened) restored.add(key);
      }
    }
    for (const key of restored) {
      if (current.has(key)) continue;
      forgetInteraction(key);
      restored.delete(key);
    }
  }, [
    messages,
    setMessages,
    saveAssistantMessage,
    conversationId,
    getSessionVersion,
    releaseConversation,
  ]);

  // Sent once the answer is in the messages, so the new turn's history has it.
  useEffect(() => {
    const followUp = followUpRef.current;
    if (!followUp || followUp.pending !== 0) return;
    followUpRef.current = null;
    if (followUp.text && followUp.version === getSessionVersion?.())
      void send(followUp.text, followUp.options);
  }, [messages, send, getSessionVersion]);

  useEffect(() => {
    pruneInteractions(messages.map((message) => message.id));
  }, [messages]);

  useEffect(() => {
    const restored = restoredRef.current;
    const unsubscribe = useAgentInteractionStore.subscribe(() =>
      pruneInteractions(latestRef.current.messages.map((message) => message.id))
    );
    return () => {
      unsubscribe();
      for (const key of restored) forgetInteraction(key);
      restored.clear();
      pruneInteractions([]);
    };
  }, []);
}
