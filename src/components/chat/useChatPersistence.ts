import { useState, useRef, useCallback, useEffect } from "react";
import type { Message, ToolCallInfo } from "./types";
import type { TurnDetails } from "./useChatStreaming";
import type { ContainerScope } from "../../types/chat";
import { getAuthRequestContextSnapshot, subscribeAuthBoundary } from "../../lib/authRequestContext";
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

export interface ConversationClaim {
  release: () => Promise<void>;
  /** Present when this window reacquired an idle conversation. */
  messages?: Message[];
}

export interface ChatPersistence {
  messages: Message[];
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  conversationId: number | null;
  /** Null for a conversation that isn't a fork. */
  forkOrigin: ForkOrigin | null;
  /** The note the open conversation was started from; undefined while it loads. */
  noteId: number | null | undefined;
  createConversation: (
    title: string,
    noteId?: number | null,
    scope?: ContainerScope
  ) => Promise<number>;
  /** False for an obsolete load; null for a missing conversation; true when loaded. */
  loadConversation: (
    id: number,
    beforeOpen?: () => void,
    canOpen?: (conversation: StoredChatConversation) => Promise<boolean>
  ) => Promise<boolean | null>;
  /** Changes when the user leaves this conversation, including before a send starts. */
  getSessionVersion: () => number;
  claimConversation: (id: number) => Promise<false | ConversationClaim>;
  releaseConversation: (id: number) => Promise<void>;
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
    forkContext?: string,
    beforeOpen?: () => void
  ) => Promise<number | false | null>;
  handleNewChat: () => void;
}

export function useChatPersistence(options: UseChatPersistenceOptions = {}): ChatPersistence {
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(
    options.conversationId ?? null
  );
  const [forkOrigin, setForkOrigin] = useState<ForkOrigin | null>(null);
  const conversationIdRef = useRef(conversationId);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  // One save at a time per reply, so a reply saved while it waited is
  // completed in place rather than added twice.
  const savedRowsRef = useRef(new Map<string, Promise<number | null>>());
  const [noteId, setNoteId] = useState<number | null | undefined>(null);
  const sessionVersionRef = useRef(0);
  const navigationVersionRef = useRef(0);
  const accountVersionRef = useRef(0);
  const ownerIdRef = useRef(crypto.randomUUID());
  const ownedConversationRef = useRef<number | null>(null);
  const blockedConversationRef = useRef<number | null>(null);
  const releasingRef = useRef(Promise.resolve());
  const releaseConversation = useCallback(
    (id: number, expectedOwner = ownerIdRef.current): Promise<void> => {
      if (ownedConversationRef.current !== id || expectedOwner !== ownerIdRef.current)
        return releasingRef.current;
      ownedConversationRef.current = null;
      const ownerId = ownerIdRef.current;
      releasingRef.current = (async () => {
        await Promise.allSettled([...savedRowsRef.current.values()]);
        await window.electronAPI?.releaseAgentConversation?.(id, ownerId);
      })();
      return releasingRef.current;
    },
    []
  );
  const claimConversation = useCallback(
    async (id: number) => {
      const version = sessionVersionRef.current;
      const ownerId = ownerIdRef.current;
      await releasingRef.current;
      if (version !== sessionVersionRef.current) return false;
      const claim = await window.electronAPI?.claimAgentConversation?.(id, ownerId);
      if (claim && version !== sessionVersionRef.current) {
        if (claim.owned) void window.electronAPI?.releaseAgentConversation?.(id, ownerId);
        return false;
      }
      if (claim && !claim.owned) return false;
      let messages: Message[] | undefined;
      if (claim?.conversation && ownedConversationRef.current !== id) {
        messages = decodeChatMessages(claim.conversation).map((message) => {
          const existing = messagesRef.current.find((shown) => shown.dbId === message.dbId);
          return existing ? { ...message, id: existing.id } : message;
        });
        messagesRef.current = messages;
        setMessages(messages);
      }
      ownedConversationRef.current = id;
      return { release: () => releaseConversation(id, ownerId), ...(messages ? { messages } : {}) };
    },
    [releaseConversation]
  );
  const getSessionVersion = useCallback(() => sessionVersionRef.current, []);

  useEffect(
    () => () => {
      sessionVersionRef.current += 1;
      if (ownedConversationRef.current != null)
        void releaseConversation(ownedConversationRef.current);
    },
    [releaseConversation]
  );

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const setDbId = useCallback((messageId: string, dbId: number) => {
    setMessages((prev) =>
      prev.map((message) => (message.id === messageId ? { ...message, dbId } : message))
    );
  }, []);

  const showConversation = useCallback(
    (conversation: StoredChatConversation, messages: Message[]) => {
      conversationIdRef.current = conversation.id;
      setConversationId(conversation.id);
      setNoteId(conversation.note_id ?? null);
      setForkOrigin(forkOriginOf(conversation));
      setMessages(messages);
    },
    []
  );

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
    async (
      id: number,
      beforeOpen?: () => void,
      canOpen?: (conversation: StoredChatConversation) => Promise<boolean>
    ): Promise<boolean | null> => {
      const navigationVersion = ++navigationVersionRef.current;
      if (beforeOpen || canOpen) {
        const version = sessionVersionRef.current;
        const target = await window.electronAPI?.getAgentConversation?.(id);
        if (
          version !== sessionVersionRef.current ||
          navigationVersion !== navigationVersionRef.current
        )
          return false;
        if (!target) return null;
        if (canOpen && !(await canOpen(target))) return false;
        if (
          version !== sessionVersionRef.current ||
          navigationVersion !== navigationVersionRef.current
        )
          return false;
        beforeOpen?.();
      }
      const version = ++sessionVersionRef.current;
      // Unknown up front, so the last conversation's note never grounds a send made while this loads.
      setNoteId(undefined);
      if (ownedConversationRef.current != null)
        await releaseConversation(ownedConversationRef.current);
      await releasingRef.current;
      if (
        version !== sessionVersionRef.current ||
        navigationVersion !== navigationVersionRef.current
      )
        return false;
      const ownerId = crypto.randomUUID();
      ownerIdRef.current = ownerId;
      blockedConversationRef.current = null;
      const claim = await window.electronAPI?.claimAgentConversation?.(id, ownerId);
      const conv = claim
        ? claim.conversation
        : await window.electronAPI?.getAgentConversation?.(id);
      if (claim?.owned) {
        if (
          version !== sessionVersionRef.current ||
          navigationVersion !== navigationVersionRef.current
        ) {
          void window.electronAPI?.releaseAgentConversation?.(id, ownerId);
          return false;
        }
        ownedConversationRef.current = id;
      }
      if (
        version !== sessionVersionRef.current ||
        navigationVersion !== navigationVersionRef.current
      )
        return false;
      if (!conv) {
        // The conversation was deleted elsewhere (e.g. ControlPanel history).
        // Clear the id, or every subsequent save silently no-ops against the
        // tombstoned row and the session is never persisted.
        conversationIdRef.current = null;
        setConversationId(null);
        setForkOrigin(null);
        setNoteId(null);
        setMessages([]);
        return null;
      }
      const recover = !claim || claim.owned;
      if (!recover) blockedConversationRef.current = id;
      const messages = decodeChatMessages(conv, recover);
      showConversation(conv, messages);
      const hasRecovery = messages
        .at(-1)
        ?.toolCalls?.some(
          (call) =>
            call.interaction?.state === "pending" || call.interaction?.state === "interrupted"
        );
      if (recover && !hasRecovery) void releaseConversation(id);
      return true;
    },
    [releaseConversation, showConversation]
  );

  useEffect(
    () =>
      window.electronAPI?.onAgentConversationReleased?.(({ conversationId: id }) => {
        if (blockedConversationRef.current === id && conversationIdRef.current === id) {
          void loadConversation(id);
        }
      }),
    [loadConversation]
  );

  const saveUserMessage = useCallback(
    async (
      text: string,
      { messageId, selectedContext, selectedContextSource }: UserMessageDetails = {}
    ) => {
      const conversationId = conversationIdRef.current;
      if (!conversationId) return;
      const accountVersion = accountVersionRef.current;
      const authGeneration = getAuthRequestContextSnapshot().observedGeneration;
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
          if (
            accountVersion === accountVersionRef.current &&
            authGeneration === getAuthRequestContextSnapshot().observedGeneration &&
            row &&
            messageId
          )
            setDbId(messageId, row.id);
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
      const accountVersion = accountVersionRef.current;
      const authGeneration = getAuthRequestContextSnapshot().observedGeneration;
      const accountCurrent = () =>
        accountVersion === accountVersionRef.current &&
        authGeneration === getAuthRequestContextSnapshot().observedGeneration;
      const metadata = replyMetadata(toolCalls, details.turn);
      const savedRow =
        savedRowsRef.current.get(messageId) ??
        Promise.resolve(
          details.rowId ?? messagesRef.current.find((m) => m.id === messageId)?.dbId ?? null
        );
      const saving = savedRow.then((rowId) =>
        accountCurrent() ? saveReplyRow(conversationId, rowId, content, metadata) : null
      );
      savedRowsRef.current.set(
        messageId,
        saving.catch(() => null)
      );
      const rowId = await saving;
      if (accountCurrent() && rowId != null) setDbId(messageId, rowId);
    },
    [setDbId]
  );

  const forkConversation = useCallback(
    async (throughMessage: Message, forkContext?: string, beforeOpen?: () => void) => {
      const sourceId = conversationIdRef.current;
      if (!sourceId || throughMessage.dbId == null) return null;
      const version = sessionVersionRef.current;
      const navigationVersion = ++navigationVersionRef.current;
      const isCurrent = (): boolean =>
        version === sessionVersionRef.current && navigationVersion === navigationVersionRef.current;
      let fork;
      try {
        fork = await window.electronAPI?.forkAgentConversation?.(
          sourceId,
          throughMessage.dbId,
          forkContext ?? null
        );
      } catch {
        return isCurrent() ? null : false;
      }
      if (!isCurrent()) return false;
      if (!fork) return null;
      beforeOpen?.();
      const opened = await loadConversation(fork.id);
      return opened === true ? fork.id : opened;
    },
    [loadConversation]
  );

  const handleNewChat = useCallback(() => {
    sessionVersionRef.current += 1;
    blockedConversationRef.current = null;
    if (ownedConversationRef.current != null)
      void releaseConversation(ownedConversationRef.current);
    ownerIdRef.current = crypto.randomUUID();
    setMessages([]);
    setForkOrigin(null);
    conversationIdRef.current = null;
    setConversationId(null);
    setNoteId(null);
  }, [releaseConversation]);

  useEffect(
    () =>
      subscribeAuthBoundary(() => {
        accountVersionRef.current += 1;
        handleNewChat();
        savedRowsRef.current.clear();
      }),
    [handleNewChat]
  );

  return {
    messages,
    setMessages,
    conversationId,
    forkOrigin,
    noteId,
    getSessionVersion,
    claimConversation,
    releaseConversation,
    createConversation,
    loadConversation,
    saveUserMessage,
    saveAssistantMessage,
    forkConversation,
    handleNewChat,
  };
}
