import { useState, useRef, useCallback, useEffect } from "react";
import type { AssistantTurn, AssistantTurnStatus, Message, ToolCallInfo } from "./types";
import type { TurnDetails } from "./useChatStreaming";
import type { ContainerScope } from "../../types/chat";
import type { AgentConversationWithMessages, AgentMessageRow } from "../../types/electron";
import { getAuthRequestContextSnapshot, subscribeAuthBoundary } from "../../lib/authRequestContext";
import { connectsFirst } from "./historyMessages";
import logger from "../../utils/logger";
import { withoutSkillCardDrafts } from "./skillCardRecord";

interface UseChatPersistenceOptions {
  conversationId?: number | null;
  onConversationCreated?: (id: number, title: string) => void;
}

/** Where the open conversation was forked from. */
export interface ForkOrigin {
  parentConversationId: number;
  /** Null once the parent is deleted. */
  parentTitle: string | null;
  /** The fork's own title as it loaded: its parent's until it is named or renamed. */
  title: string;
  /** Text the fork was made from; it goes with the fork's next request. */
  context: string | null;
  /** How many of the fork's first messages are the parent's history. */
  copiedMessageCount: number;
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
  createConversation: (
    title: string,
    noteId?: number | null,
    scope?: ContainerScope
  ) => Promise<number>;
  /** False for an obsolete load; null for a missing conversation; true when loaded. */
  loadConversation: (id: number, beforeOpen?: () => void) => Promise<boolean | null>;
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
        messages = claim.conversation.messages.map((row) => {
          const existing = messagesRef.current.find((message) => message.dbId === row.id);
          return { ...messageFromRow(row), ...(existing ? { id: existing.id } : {}) };
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
    (conversation: AgentConversationWithMessages, recover = true) => {
      conversationIdRef.current = conversation.id;
      setConversationId(conversation.id);
      setForkOrigin(
        conversation.parent_conversation_id != null
          ? {
              parentConversationId: conversation.parent_conversation_id,
              parentTitle: conversation.parent_title ?? null,
              title: conversation.title,
              context: conversation.fork_context ?? null,
              copiedMessageCount: conversation.fork_message_count ?? 0,
            }
          : null
      );
      setMessages(conversation.messages.map((row) => messageFromRow(row, recover)));
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
      options.onConversationCreated?.(id, title);
      return id;
    },
    [options]
  );

  const loadConversation = useCallback(
    async (id: number, beforeOpen?: () => void) => {
      const navigationVersion = ++navigationVersionRef.current;
      if (beforeOpen) {
        const version = sessionVersionRef.current;
        const target = await window.electronAPI?.getAgentConversation?.(id);
        if (
          version !== sessionVersionRef.current ||
          navigationVersion !== navigationVersionRef.current
        )
          return false;
        if (!target) return null;
        beforeOpen();
      }
      const version = ++sessionVersionRef.current;
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
        setMessages([]);
        return null;
      }
      const recover = !claim || claim.owned;
      if (!recover) blockedConversationRef.current = id;
      showConversation(conv, recover);
      const last = conv.messages.at(-1);
      const metadata = last?.metadata ? tryParseMetadata(last.metadata) : undefined;
      const hasRecovery = (metadata?.toolCalls as ToolCallInfo[] | undefined)?.some(
        (call) => call.interaction?.state === "pending" || call.interaction?.state === "interrupted"
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
      const metadata =
        toolCalls?.length || details.turn
          ? {
              ...(toolCalls?.length ? { toolCalls: withoutSkillCardDrafts(toolCalls) } : {}),
              ...(details.turn ? { turn: details.turn } : {}),
            }
          : undefined;
      const savedRow =
        savedRowsRef.current.get(messageId) ??
        Promise.resolve(messagesRef.current.find((m) => m.id === messageId)?.dbId ?? null);
      const saving = savedRow.then(async (rowId) => {
        if (!accountCurrent()) return null;
        if (rowId != null) {
          try {
            await window.electronAPI?.updateAgentMessage?.(rowId, content, metadata);
          } catch (error) {
            logger.warn("Unable to update saved reply", { error }, "chat");
          }
          return rowId;
        }
        if (!accountCurrent()) return null;
        const row = await window.electronAPI?.addAgentMessage?.(
          conversationId,
          "assistant",
          content,
          metadata
        );
        return row?.id ?? null;
      });
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

// Nothing saved is still running once it loads. A reply saved while it
// waited, whose wait ended with the app or the chat view, can still be
// answered: it loads as interrupted. One saved mid-turn (the app quit after
// an answer) loads as stopped, and so does every call it had running.
function settledOnLoad(turn: AssistantTurn | undefined, toolCalls: ToolCallInfo[] | undefined) {
  const status: AssistantTurnStatus | null =
    turn?.status === "waiting" ? "interrupted" : turn?.status === "running" ? "stopped" : null;
  return {
    turn: turn && status ? { ...turn, status } : turn,
    toolCalls: toolCalls?.map((call): ToolCallInfo => {
      const outcome = call.metadata && !Array.isArray(call.metadata) ? call.metadata.status : null;
      if (
        connectsFirst(call) &&
        (call.interaction?.state === "pending" || call.interaction?.state === "interrupted") &&
        !outcome
      ) {
        call = { ...call, metadata: { status: "not_sent" } };
      }
      if (call.status !== "executing") return call;
      return call.interaction?.state === "pending"
        ? { ...call, status: "stopped", interaction: { ...call.interaction, state: "interrupted" } }
        : { ...call, status: "stopped" };
    }),
  };
}

function messageFromRow(row: AgentMessageRow, recover = true): Message {
  const metadata = row.metadata ? tryParseMetadata(row.metadata) : undefined;
  const savedTurn = metadata?.turn as AssistantTurn | undefined;
  const savedCalls = metadata?.toolCalls as ToolCallInfo[] | undefined;
  const { turn, toolCalls } = recover
    ? settledOnLoad(savedTurn, savedCalls)
    : {
        turn: savedTurn,
        toolCalls: savedCalls?.map((call) =>
          call.interaction?.state === "interrupted"
            ? { ...call, interaction: { ...call.interaction, state: "pending" as const } }
            : call
        ),
      };
  const selectedContext = metadata?.selectedContext;
  const fromAnotherApp = metadata?.selectedContextSource === "external";
  return {
    id: crypto.randomUUID(),
    dbId: row.id,
    role: row.role as Message["role"],
    content: row.content,
    isStreaming: false,
    ...(toolCalls ? { toolCalls } : {}),
    ...(turn ? { turn } : {}),
    ...(typeof selectedContext === "string" ? { selectedContext } : {}),
    ...(fromAnotherApp ? { selectedContextSource: "external" as const } : {}),
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
