import { useState, useRef, useCallback, useEffect } from "react";
import type { Message, ToolCallInfo } from "./types";
import type { ContainerScope } from "../../types/chat";

interface UseChatPersistenceOptions {
  conversationId?: number | null;
  onConversationCreated?: (id: number, title: string) => void;
}

export interface ChatPersistence {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: number | null;
  createConversation: (
    title: string,
    noteId?: number | null,
    scope?: ContainerScope
  ) => Promise<number>;
  loadConversation: (id: number) => Promise<boolean>;
  /** Changes when the user leaves this conversation, including before a send starts. */
  getSessionVersion: () => number;
  saveUserMessage: (text: string) => Promise<void>;
  saveAssistantMessage: (content: string, toolCalls?: ToolCallInfo[]) => Promise<void>;
  handleNewChat: () => void;
}

export function useChatPersistence(options: UseChatPersistenceOptions = {}): ChatPersistence {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(
    options.conversationId ?? null
  );
  const conversationIdRef = useRef(conversationId);
  const sessionVersionRef = useRef(0);
  const getSessionVersion = useCallback(() => sessionVersionRef.current, []);

  useEffect(
    () => () => {
      sessionVersionRef.current += 1;
    },
    []
  );

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const createConversation = useCallback(
    async (title: string, noteId?: number | null, scope?: ContainerScope): Promise<number> => {
      const version = sessionVersionRef.current;
      const conv = await window.electronAPI?.createAgentConversation?.(
        title,
        noteId ?? undefined,
        scope?.spaceId,
        scope?.folderId ?? undefined
      );
      if (version !== sessionVersionRef.current) {
        throw new DOMException("Conversation changed", "AbortError");
      }
      if (!conv) {
        throw new Error("Conversation scope is no longer available");
      }
      const id = conv.id;
      conversationIdRef.current = id;
      setConversationId(id);
      options.onConversationCreated?.(id, title);
      return id;
    },
    [options]
  );

  const loadConversation = useCallback(async (id: number) => {
    const version = ++sessionVersionRef.current;
    const conv = await window.electronAPI?.getAgentConversation?.(id);
    if (version !== sessionVersionRef.current) return false;
    if (!conv) {
      // The conversation was deleted elsewhere (e.g. ControlPanel history).
      // Clear the id, or every subsequent save silently no-ops against the
      // tombstoned row and the session is never persisted.
      conversationIdRef.current = null;
      setConversationId(null);
      return false;
    }
    conversationIdRef.current = id;
    setConversationId(id);
    const loaded: Message[] = conv.messages.map((m) => {
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
    return true;
  }, []);

  const saveUserMessage = useCallback(async (text: string) => {
    if (conversationIdRef.current) {
      window.electronAPI?.addAgentMessage?.(conversationIdRef.current, "user", text);
    }
  }, []);

  const saveAssistantMessage = useCallback(async (content: string, toolCalls?: ToolCallInfo[]) => {
    if (conversationIdRef.current) {
      window.electronAPI?.addAgentMessage?.(
        conversationIdRef.current,
        "assistant",
        content,
        toolCalls?.length ? { toolCalls } : undefined
      );
    }
  }, []);

  const handleNewChat = useCallback(() => {
    sessionVersionRef.current += 1;
    setMessages([]);
    conversationIdRef.current = null;
    setConversationId(null);
  }, []);

  return {
    messages,
    setMessages,
    conversationId,
    getSessionVersion,
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
