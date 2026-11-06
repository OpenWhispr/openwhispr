import { useState, useRef, useCallback, useEffect } from "react";
import type { Message, ToolCallInfo } from "./types";
import type { ContainerScope } from "../../types/chat";
import { decodeChatMessages } from "./chatPersistence";
import { withoutSkillCardDrafts } from "./skillCardRecord";

interface UseChatPersistenceOptions {
  conversationId?: number | null;
  onConversationCreated?: (id: number, title: string) => void;
}

export interface ChatPersistence {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: number | null;
  /** The note the open conversation was started from; undefined while it loads. */
  noteId: number | null | undefined;
  createConversation: (
    title: string,
    noteId?: number | null,
    scope?: ContainerScope
  ) => Promise<number>;
  /** False for an obsolete load; null for a missing conversation; true when loaded. */
  loadConversation: (id: number) => Promise<boolean | null>;
  /** Changes when the user leaves this conversation, including before a send starts. */
  getSessionVersion: () => number;
  saveUserMessage: (text: string) => Promise<void>;
  saveAssistantMessage: (
    content: string,
    toolCalls?: ToolCallInfo[],
    conversationId?: number | null
  ) => Promise<void>;
  handleNewChat: () => void;
}

export function useChatPersistence(options: UseChatPersistenceOptions = {}): ChatPersistence {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(
    options.conversationId ?? null
  );
  const conversationIdRef = useRef(conversationId);
  const [noteId, setNoteId] = useState<number | null | undefined>(null);
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
      setNoteId(noteId ?? null);
      options.onConversationCreated?.(id, title);
      return id;
    },
    [options]
  );

  const loadConversation = useCallback(async (id: number) => {
    const version = ++sessionVersionRef.current;
    // Unknown up front, so the last conversation's note never grounds a send made while this loads.
    setNoteId(undefined);
    const conv = await window.electronAPI?.getAgentConversation?.(id);
    if (version !== sessionVersionRef.current) return false;
    if (!conv) {
      // The conversation was deleted elsewhere (e.g. ControlPanel history).
      // Clear the id, or every subsequent save silently no-ops against the
      // tombstoned row and the session is never persisted.
      conversationIdRef.current = null;
      setConversationId(null);
      setNoteId(null);
      setMessages([]);
      return null;
    }
    conversationIdRef.current = id;
    setConversationId(id);
    setNoteId(conv.note_id ?? null);
    setMessages(decodeChatMessages(conv));
    return true;
  }, []);

  const saveUserMessage = useCallback(async (text: string) => {
    if (conversationIdRef.current) {
      window.electronAPI?.addAgentMessage?.(conversationIdRef.current, "user", text);
    }
  }, []);

  const saveAssistantMessage = useCallback(
    async (
      content: string,
      toolCalls?: ToolCallInfo[],
      targetConversationId = conversationIdRef.current
    ): Promise<void> => {
      if (targetConversationId) {
        window.electronAPI?.addAgentMessage?.(
          targetConversationId,
          "assistant",
          content,
          toolCalls?.length ? { toolCalls: withoutSkillCardDrafts(toolCalls) } : undefined
        );
      }
    },
    []
  );

  const handleNewChat = useCallback(() => {
    sessionVersionRef.current += 1;
    setMessages([]);
    conversationIdRef.current = null;
    setConversationId(null);
    setNoteId(null);
  }, []);

  return {
    messages,
    setMessages,
    conversationId,
    noteId,
    getSessionVersion,
    createConversation,
    loadConversation,
    saveUserMessage,
    saveAssistantMessage,
    handleNewChat,
  };
}
