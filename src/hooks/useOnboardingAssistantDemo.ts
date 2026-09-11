import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStreaming } from "../components/chat/useChatStreaming";
import { buildAssistantDemoRequest } from "../utils/onboardingDemo";
import type { ChatImageAttachment, Message } from "../components/chat/types";
import type { OnboardingDemoEvent } from "../types/electron";

export interface OnboardingAssistantCommand {
  text: string;
  attachment: ChatImageAttachment | null;
}

type DemoEventInput = Omit<OnboardingDemoEvent, "demoId" | "kind">;

/**
 * Answers the onboarding assistant demo headlessly from the dictation window,
 * where the screenshot, tool registry and Voice Assistant scope live. The reply
 * travels back as demo events: "replying" while it streams, "success" once it
 * lands, and "error" when the stream ends without a reply.
 */
export function useOnboardingAssistantDemo(publish: (event: DemoEventInput) => void) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const repliedRef = useRef(false);
  const { agentState, activeToolName, sendToAI } = useChatStreaming({
    messages,
    setMessages,
    inferenceScope: "dictationAgent",
  });

  const reply = messages.find((message) => message.role === "assistant");
  const settled = agentState === "idle" && reply !== undefined && !reply.isStreaming;

  useEffect(() => {
    if (!reply) return;
    if (!settled) {
      publish({ status: "replying", text: reply.content, tool: activeToolName || undefined });
    } else if (!repliedRef.current) {
      publish({ status: "error", message: reply.content });
    }
  }, [activeToolName, publish, reply, settled]);

  return useCallback(
    (command: OnboardingAssistantCommand) => {
      repliedRef.current = false;
      const request = buildAssistantDemoRequest(command.text, {
        senderName: t("onboarding.rehaul.assistantDemo.email.senderName"),
        subject: t("onboarding.rehaul.assistantDemo.email.subject"),
        body: t("onboarding.rehaul.assistantDemo.email.body"),
      });
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: request,
        isStreaming: false,
      };
      setMessages([userMessage]);
      void sendToAI(request, [userMessage], {
        attachment: command.attachment ?? undefined,
        suppressResponseContent: true,
        onComplete: ({ content }) => {
          repliedRef.current = true;
          publish({ status: "success", text: content });
        },
      });
    },
    [publish, sendToAI, t]
  );
}
