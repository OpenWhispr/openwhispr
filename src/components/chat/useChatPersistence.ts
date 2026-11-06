import { useState, useRef, useCallback, useEffect } from "react";
import type { Message, ToolCallInfo } from "./types";
import type { TurnDetails } from "./useChatStreaming";
import type { ContainerScope } from "../../types/chat";
import {
  decodeChatMessages,
  forkOriginOf,
  replyMetadata,
  saveReplyRow,
  type ForkOrigin,
  type StoredChatConversation,
} from "./chatPersistence";

export type { ForkOrigin } from "./chatPersistence";

interface UseChatPersistenceOptions {
  conversationId?: number | null;
  onConversationCreated?: (id: number, title: string) => void;
}

interface UserMessageDetails {
  messageId?: string;
  selectedContext?: string;
  selectedContextSource?: Message["selectedContextSource"];
}

export interface ChatPersistence {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: number | null;
  /** The note the open conversation was started from; undefined while it loads. */
  noteId: number | null | undefined;
  /** Null for a conversation that isn't a fork. */
  forkOrigin: ForkOrigin | null;
  createConversation: (
    title: string,
    noteId?: number | null,
    scope?: ContainerScope
  ) => Promise<number>;
  /** False for an obsolete load; null for a missing conversation; true when loaded. */
  loadConversation: (id: number) => Promise<boolean | null>;
  /** Changes when the user leaves this conversation, including before a send starts. */
  getSessionVersion: () => number;
  saveUserMessage: (text: string, options?: UserMessageDetails) => Promise<void>;
  /** Saves a reply, or completes the one saved while it waited on the user. */
  saveAssistantMessage: (
    messageId: string,
    content: string,
    toolCalls?: ToolCallInfo[],
    details?: Partial<TurnDetails>
  ) => Promise<void>;
  /**
   * A new chat with the history through a saved message; opens it and returns
   * its id. False when the user left for another chat first; null on failure.
   */
  forkConversation: (
    throughMessage: Message,
    forkContext?: string
  ) => Promise<number | false | null>;
  handleNewChat: () => void;
}

export function useChatPersistence(options: UseChatPersistenceOptions = {}): ChatPersistence {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(
    options.conversationId ?? null
  );
  const [noteId, setNoteId] = useState<number | null | undefined>(null);
  const [forkOrigin, setForkOrigin] = useState<ForkOrigin | null>(null);
  const conversationIdRef = useRef(conversationId);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // One save at a time per reply, so a reply saved while it waited is
  // completed in place rather than added twice.
  const savedRowsRef = useRef(new Map<string, Promise<number | null>>());
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

  const setDbId = useCallback((messageId: string, dbId: number) => {
    setMessages((prev) =>
      prev.map((message) => (message.id === messageId ? { ...message, dbId } : message))
    );
  }, []);

  const showConversation = useCallback((conversation: StoredChatConversation) => {
    conversationIdRef.current = conversation.id;
    setConversationId(conversation.id);
    setNoteId(conversation.note_id ?? null);
    setForkOrigin(forkOriginOf(conversation));
    setMessages(decodeChatMessages(conversation));
  }, []);

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

  const loadConversation = useCallback(
    async (id: number) => {
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
        setForkOrigin(null);
        setMessages([]);
        return null;
      }
      showConversation(conv);
      return true;
    },
    [showConversation]
  );

  const saveUserMessage = useCallback(
    async (
      text: string,
      { messageId, selectedContext, selectedContextSource }: UserMessageDetails = {}
    ) => {
      const conversationId = conversationIdRef.current;
      if (!conversationId) return;
      // Not awaited: the reply starts while the message is written.
      void window.electronAPI
        ?.addAgentMessage?.(
          conversationId,
          "user",
          text,
          selectedContext
            ? { selectedContext, ...(selectedContextSource ? { selectedContextSource } : {}) }
            : undefined
        )
        .then((row) => {
          if (row && messageId) setDbId(messageId, row.id);
        });
    },
    [setDbId]
  );

  const saveAssistantMessage = useCallback(
    async (
      messageId: string,
      content: string,
      toolCalls?: ToolCallInfo[],
      details: Partial<TurnDetails> = {}
    ) => {
      const conversationId = details.conversationId ?? conversationIdRef.current;
      if (!conversationId) return;
      const metadata = replyMetadata(toolCalls, details.turn);
      const savedRow =
        savedRowsRef.current.get(messageId) ??
        Promise.resolve(messagesRef.current.find((m) => m.id === messageId)?.dbId ?? null);
      const saving = savedRow.then((rowId) =>
        saveReplyRow(conversationId, rowId, content, metadata)
      );
      savedRowsRef.current.set(
        messageId,
        saving.catch(() => null)
      );
      const rowId = await saving;
      if (rowId != null) setDbId(messageId, rowId);
    },
    [setDbId]
  );

  const forkConversation = useCallback(
    async (throughMessage: Message, forkContext?: string) => {
      const sourceId = conversationIdRef.current;
      if (!sourceId || throughMessage.dbId == null) return null;
      const version = ++sessionVersionRef.current;
      const fork = await window.electronAPI?.forkAgentConversation?.(
        sourceId,
        throughMessage.dbId,
        forkContext ?? null
      );
      if (version !== sessionVersionRef.current) return false;
      if (!fork) return null;
      showConversation(fork);
      return fork.id;
    },
    [showConversation]
  );

  const handleNewChat = useCallback(() => {
    sessionVersionRef.current += 1;
    setMessages([]);
    setForkOrigin(null);
    conversationIdRef.current = null;
    setConversationId(null);
    setNoteId(null);
  }, []);

  return {
    messages,
    setMessages,
    conversationId,
    noteId,
    forkOrigin,
    getSessionVersion,
    createConversation,
    loadConversation,
    saveUserMessage,
    saveAssistantMessage,
    forkConversation,
    handleNewChat,
  };
}
