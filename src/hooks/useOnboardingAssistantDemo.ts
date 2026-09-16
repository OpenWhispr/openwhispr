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

type DemoEventInput = Omit<OnboardingDemoEvent, "kind">;

/**
 * Answers the onboarding assistant demo headlessly from the dictation window,
 * where the screenshot, tool registry and Voice Assistant scope live. The reply
 * travels back as demo events: "replying" while it streams, "success" once it
 * lands, and "error" when the stream ends without a reply.
 */
export function useOnboardingAssistantDemo(publish: (event: DemoEventInput) => void) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<Message[]>([]);
  const terminalPublishedRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const requestGenerationRef = useRef(0);
  const activeStreamRef = useRef(false);
  const requestMessageIdRef = useRef<string | null>(null);
  const { agentState, activeToolName, sendToAI, cancelStream } = useChatStreaming({
    messages,
    setMessages,
    inferenceScope: "dictationAgent",
  });

  const reply = messages.find((message) => message.role === "assistant");
  const settled = agentState === "idle" && reply !== undefined && !reply.isStreaming;

  const cancel = useCallback(() => {
    requestGenerationRef.current += 1;
    sessionIdRef.current = null;
    requestMessageIdRef.current = null;
    terminalPublishedRef.current = false;
    if (activeStreamRef.current) {
      activeStreamRef.current = false;
      cancelStream();
    }
    setMessages([]);
  }, [cancelStream]);

  useEffect(() => {
    const unsubscribe = window.electronAPI?.onOnboardingDemoEvent?.((event) => {
      if (
        event.kind !== "assistant" ||
        !["preparing", "listening", "cancelled"].includes(event.status)
      )
        return;
      if (sessionIdRef.current && event.demoId !== sessionIdRef.current) return;
      cancel();
    });
    return () => {
      unsubscribe?.();
      cancel();
    };
  }, [cancel]);

  useEffect(() => {
    const demoId = sessionIdRef.current;
    if (
      !reply ||
      !demoId ||
      messages[0]?.id !== requestMessageIdRef.current ||
      terminalPublishedRef.current
    )
      return;
    if (!settled) {
      publish({
        demoId,
        status: "replying",
        text: reply.content,
        tool: activeToolName || undefined,
      });
    } else {
      terminalPublishedRef.current = true;
      publish({ demoId, status: "error", message: reply.content });
    }
  }, [activeToolName, messages, publish, reply, settled]);

  const run = useCallback(
    async (command: OnboardingAssistantCommand) => {
      cancel();
      const generation = requestGenerationRef.current;
      const session = await window.electronAPI?.getOnboardingDemoSession?.();
      if (generation !== requestGenerationRef.current || session?.kind !== "assistant") return;
      sessionIdRef.current = session.id;
      terminalPublishedRef.current = false;
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
      requestMessageIdRef.current = userMessage.id;
      setMessages([userMessage]);
      activeStreamRef.current = true;
      void sendToAI(request, [userMessage], {
        attachment: command.attachment ?? undefined,
        suppressResponseContent: true,
        onError: ({ message, code }) => {
          if (generation !== requestGenerationRef.current) return;
          terminalPublishedRef.current = true;
          publish({ demoId: session.id, status: "error", message, code });
        },
        onComplete: ({ content }) => {
          if (generation !== requestGenerationRef.current) return;
          terminalPublishedRef.current = true;
          publish({ demoId: session.id, status: "success", text: content });
        },
      }).finally(() => {
        if (generation === requestGenerationRef.current) activeStreamRef.current = false;
      });
    },
    [cancel, publish, sendToAI, t]
  );

  return { run, cancel };
}
