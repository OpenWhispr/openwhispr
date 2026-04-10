import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Message, AgentState, ToolCallInfo } from "../chat/types";
import type { ChatStreaming } from "../chat/useChatStreaming";

interface UseOpenClawStreamingOptions {
  getSessionKey: () => string | null;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  onStreamComplete?: (assistantId: string, content: string, toolCalls?: ToolCallInfo[]) => void;
}

export function useOpenClawStreaming({
  getSessionKey,
  setMessages,
  onStreamComplete,
}: UseOpenClawStreamingOptions): ChatStreaming {
  const { t } = useTranslation();
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [toolStatus, setToolStatus] = useState("");
  const [activeToolName, setActiveToolName] = useState("");

  const getSessionKeyRef = useRef(getSessionKey);
  getSessionKeyRef.current = getSessionKey;
  const onStreamCompleteRef = useRef(onStreamComplete);
  onStreamCompleteRef.current = onStreamComplete;
  const assistantIdByMessageIdRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const api = window.electronAPI?.openclaw;
    if (!api) return;

    const ensureAssistantMessage = (remoteMessageId: string): string => {
      const existing = assistantIdByMessageIdRef.current.get(remoteMessageId);
      if (existing) return existing;
      const assistantId = crypto.randomUUID();
      assistantIdByMessageIdRef.current.set(remoteMessageId, assistantId);
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", isStreaming: true },
      ]);
      setAgentState("streaming");
      return assistantId;
    };

    const unsubChunk = api.onMessageChunk?.((payload) => {
      if (payload.sessionKey !== getSessionKeyRef.current()) return;
      const assistantId = ensureAssistantMessage(payload.messageId);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId ? { ...m, content: m.content + payload.delta } : m
        )
      );
    });

    const unsubDone = api.onMessageDone?.((payload) => {
      if (payload.sessionKey !== getSessionKeyRef.current()) return;
      const assistantId = ensureAssistantMessage(payload.messageId);
      assistantIdByMessageIdRef.current.delete(payload.messageId);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                content: payload.content || m.content,
                isStreaming: false,
                ...(payload.toolCalls?.length ? { toolCalls: payload.toolCalls } : {}),
              }
            : m
        )
      );
      const finalContent = payload.content || "";
      setAgentState("idle");
      setToolStatus("");
      setActiveToolName("");
      onStreamCompleteRef.current?.(assistantId, finalContent, payload.toolCalls);
    });

    const unsubToolCall = api.onToolCall?.((payload) => {
      if (payload.sessionKey !== getSessionKeyRef.current()) return;
      const assistantId = ensureAssistantMessage(payload.messageId);
      setAgentState("tool-executing");
      setActiveToolName(payload.tool);
      setToolStatus(
        t(`agentMode.tools.${payload.tool}Status`, { defaultValue: `Using ${payload.tool}...` })
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                toolCalls: [
                  ...(m.toolCalls ?? []),
                  {
                    id: crypto.randomUUID(),
                    name: payload.tool,
                    arguments: JSON.stringify(payload.input ?? {}),
                    status: "executing" as const,
                  },
                ],
              }
            : m
        )
      );
    });

    const unsubToolResult = api.onToolResult?.((payload) => {
      if (payload.sessionKey !== getSessionKeyRef.current()) return;
      const assistantId = assistantIdByMessageIdRef.current.get(payload.messageId);
      if (!assistantId) return;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== assistantId || !m.toolCalls) return m;
          const idx = [...m.toolCalls]
            .reverse()
            .findIndex((tc) => tc.name === payload.tool && tc.status === "executing");
          if (idx < 0) return m;
          const realIdx = m.toolCalls.length - 1 - idx;
          const next = [...m.toolCalls];
          next[realIdx] = {
            ...next[realIdx],
            status: "completed" as const,
            result: payload.output,
          };
          return { ...m, toolCalls: next };
        })
      );
      setAgentState("streaming");
      setToolStatus("");
      setActiveToolName("");
    });

    return () => {
      unsubChunk?.();
      unsubDone?.();
      unsubToolCall?.();
      unsubToolResult?.();
    };
  }, [setMessages, t]);

  const sendToAI = useCallback(
    async (userText: string, _allMessages: Message[]) => {
      const key = getSessionKeyRef.current();
      if (!key) return;
      setAgentState("thinking");
      try {
        await window.electronAPI?.openclaw?.sendMessage?.(key, userText);
      } catch (error) {
        setAgentState("idle");
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `${t("agentMode.chat.errorPrefix")}: ${(error as Error).message}`,
            isStreaming: false,
          },
        ]);
      }
    },
    [setMessages, t]
  );

  const cancelStream = useCallback(() => {
    const key = getSessionKeyRef.current();
    if (key) {
      window.electronAPI?.openclaw?.abort?.(key);
    }
    setAgentState("idle");
    setToolStatus("");
    setActiveToolName("");
  }, []);

  return {
    agentState,
    toolStatus,
    activeToolName,
    sendToAI,
    cancelStream,
  };
}
