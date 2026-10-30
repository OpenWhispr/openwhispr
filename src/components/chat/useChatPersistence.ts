import { useState, useRef, useCallback, useEffect } from "react";
import type { AssistantTurn, AssistantTurnStatus, Message, ToolCallInfo } from "./types";
import type { TurnDetails } from "./useChatStreaming";
import type { ContainerScope } from "../../types/chat";
import type { AgentConversationWithMessages, AgentMessageRow } from "../../types/electron";
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
  /** Text the fork was made from; it goes with the fork's next request. */
  context: string | null;
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
  loadConversation: (id: number) => Promise<boolean | null>;
  /** Changes when the user leaves this conversation, including before a send starts. */
  getSessionVersion: () => number;
  saveUserMessage: (
    text: string,
    options?: { messageId?: string; selectedContext?: string }
  ) => Promise<void>;
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

  const showConversation = useCallback((conversation: AgentConversationWithMessages) => {
    conversationIdRef.current = conversation.id;
    setConversationId(conversation.id);
    setForkOrigin(
      conversation.parent_conversation_id != null
        ? {
            parentConversationId: conversation.parent_conversation_id,
            parentTitle: conversation.parent_title ?? null,
            context: conversation.fork_context ?? null,
          }
        : null
    );
    setMessages(conversation.messages.map(messageFromRow));
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
      options.onConversationCreated?.(id, title);
      return id;
    },
    [options]
  );

  const loadConversation = useCallback(
    async (id: number) => {
      const version = ++sessionVersionRef.current;
      const conv = await window.electronAPI?.getAgentConversation?.(id);
      if (version !== sessionVersionRef.current) return false;
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
      showConversation(conv);
      return true;
    },
    [showConversation]
  );

  const saveUserMessage = useCallback(
    async (
      text: string,
      { messageId, selectedContext }: { messageId?: string; selectedContext?: string } = {}
    ) => {
      const conversationId = conversationIdRef.current;
      if (!conversationId) return;
      // Not awaited: the reply starts while the message is written.
      void window.electronAPI
        ?.addAgentMessage?.(
          conversationId,
          "user",
          text,
          selectedContext ? { selectedContext } : undefined
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
        // A cloud pull can replace the rows, and the old id with them; the reply is then added again.
        if (
          rowId != null &&
          (await window.electronAPI?.updateAgentMessage?.(rowId, content, metadata))
        ) {
          return rowId;
        }
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
  }, []);

  return {
    messages,
    setMessages,
    conversationId,
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
      if (call.status !== "executing") return call;
      return call.interaction?.state === "pending"
        ? { ...call, status: "stopped", interaction: { ...call.interaction, state: "interrupted" } }
        : { ...call, status: "stopped" };
    }),
  };
}

function messageFromRow(row: AgentMessageRow): Message {
  const metadata = row.metadata ? tryParseMetadata(row.metadata) : undefined;
  const { turn, toolCalls } = settledOnLoad(
    metadata?.turn as AssistantTurn | undefined,
    metadata?.toolCalls as ToolCallInfo[] | undefined
  );
  const selectedContext = metadata?.selectedContext;
  return {
    id: crypto.randomUUID(),
    dbId: row.id,
    role: row.role as Message["role"],
    content: row.content,
    isStreaming: false,
    ...(toolCalls ? { toolCalls } : {}),
    ...(turn ? { turn } : {}),
    ...(typeof selectedContext === "string" ? { selectedContext } : {}),
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
