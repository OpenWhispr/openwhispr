import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  restoreInteraction,
  takeGrantedImage,
  useAgentInteractionStore,
} from "../../stores/agentInteractionStore";
import { approvalKey } from "../../stores/connectorApprovalStore";
import { CONNECTION_TARGET_NAMES } from "../../config/agentCapabilities";
import type { InteractionPayload, InteractionResult } from "../../types/agentInteractions";
import type { ChatPersistence } from "./useChatPersistence";
import type { SendToAIOptions } from "./useChatStreaming";

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
        .map((question) => {
          const answer = result.answers[question.id];
          const label = (id: string) =>
            question.options?.find((option) => option.id === id)?.label ?? id;
          return `${question.prompt}\n${Array.isArray(answer) ? answer.map(label).join(", ") : label(answer)}`;
        })
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
 * the chat went away) stay answerable. An answer is recorded on the saved
 * reply and continues the task in a new turn, which sees the question and
 * the answer; nothing the turn already did runs again.
 */
export function useInterruptedInteractions(
  persistence: ChatPersistence,
  send: (text: string, options?: SendToAIOptions) => Promise<boolean>
): void {
  const { t } = useTranslation();
  const { messages, setMessages, saveAssistantMessage } = persistence;

  useEffect(() => {
    const { entries } = useAgentInteractionStore.getState();
    for (const message of messages) {
      for (const call of message.toolCalls ?? []) {
        const record = call.interaction;
        const key = approvalKey(message.id, call.id);
        if (record?.state !== "interrupted" || entries[key]) continue;
        restoreInteraction(
          { messageId: message.id, toolCallId: call.id, payload: record.payload },
          (result) => {
            const toolCalls = message.toolCalls?.map((other) =>
              other.id === call.id
                ? { ...other, interaction: { ...record, state: "settled" as const, result } }
                : other
            );
            setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, toolCalls } : m)));
            void saveAssistantMessage(message.id, message.content, toolCalls, {
              turn: message.turn,
            });
            const text = followUpText(record.payload, result, t);
            const image = takeGrantedImage(key);
            if (text) void send(text, image ? { attachment: image } : undefined);
          }
        );
      }
    }
  }, [messages, setMessages, saveAssistantMessage, send, t]);
}
