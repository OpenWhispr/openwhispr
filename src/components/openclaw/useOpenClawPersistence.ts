import { useState, useRef, useCallback } from "react";
import type { Message, ToolCallInfo } from "../chat/types";

interface UseOpenClawPersistenceOptions {
  conversationId?: number | null;
  onConversationCreated?: (id: number, title: string, sessionKey: string) => void;
}

export interface OpenClawPersistence {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: number | null;
  createConversation: (title: string) => Promise<number>;
  loadConversation: (id: number) => Promise<string | null>;
  saveUserMessage: (text: string) => Promise<void>;
  saveAssistantMessage: (content: string, toolCalls?: ToolCallInfo[]) => Promise<void>;
  handleNewChat: () => void;
}

export function useOpenClawPersistence(
  options: UseOpenClawPersistenceOptions = {}
): OpenClawPersistence {
  const [messages, setMessages] = useState<Message[]>([]);
  const conversationIdRef = useRef<number | null>(options.conversationId ?? null);
  const sessionKeyRef = useRef<string | null>(null);

  const createConversation = useCallback(
    async (title: string): Promise<number> => {
      const sessionKey = await window.electronAPI?.openclaw?.createSession?.({ label: title });
      if (!sessionKey) throw new Error("Failed to create OpenClaw session");
      const row = await window.electronAPI?.upsertOpenClawConversation?.({
        remoteSessionKey: sessionKey,
        title,
        originChannel: "openwhispr",
      });
      const id = row?.id ?? 0;
      conversationIdRef.current = id;
      sessionKeyRef.current = sessionKey;
      options.onConversationCreated?.(id, title, sessionKey);
      return id;
    },
    [options]
  );

  const loadConversation = useCallback(async (id: number): Promise<string | null> => {
    const conv = await window.electronAPI?.getOpenClawConversation?.(id);
    if (!conv) return null;
    conversationIdRef.current = id;
    sessionKeyRef.current = conv.remote_session_key ?? null;
    const loaded: Message[] = (conv.messages ?? []).map((m) => {
      const parsed = m.metadata ? tryParseMetadata(m.metadata) : undefined;
      const toolCalls = parsed?.toolCalls as ToolCallInfo[] | undefined;
      return {
        id: crypto.randomUUID(),
        role: m.role as Message["role"],
        content: m.content,
        isStreaming: false,
        ...(toolCalls ? { toolCalls } : {}),
      };
    });
    setMessages(loaded);
    return sessionKeyRef.current;
  }, []);

  const saveUserMessage = useCallback(async (text: string) => {
    if (conversationIdRef.current) {
      window.electronAPI?.addOpenClawMessage?.(conversationIdRef.current, "user", text);
    }
  }, []);

  const saveAssistantMessage = useCallback(
    async (content: string, toolCalls?: ToolCallInfo[]) => {
      if (conversationIdRef.current) {
        window.electronAPI?.addOpenClawMessage?.(
          conversationIdRef.current,
          "assistant",
          content,
          toolCalls?.length ? { toolCalls } : undefined
        );
      }
    },
    []
  );

  const handleNewChat = useCallback(() => {
    setMessages([]);
    conversationIdRef.current = null;
    sessionKeyRef.current = null;
  }, []);

  return {
    messages,
    setMessages,
    conversationId: conversationIdRef.current,
    createConversation,
    loadConversation,
    saveUserMessage,
    saveAssistantMessage,
    handleNewChat,
  };
}

function tryParseMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
