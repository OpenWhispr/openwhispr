import type { AssistantTurn, AssistantTurnStatus, Message, ToolCallInfo } from "./types";
import type { AgentConversationWithMessages, AgentMessageRow } from "../../types/electron";
import { withoutSkillCardDrafts } from "./skillCardRecord";
import { connectsFirst } from "./historyMessages";
import logger from "../../utils/logger";

export type StoredChatConversation = AgentConversationWithMessages;

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

export function forkOriginOf(row: StoredChatConversation): ForkOrigin | null {
  return row.parent_conversation_id != null
    ? {
        parentConversationId: row.parent_conversation_id,
        parentTitle: row.parent_title ?? null,
        title: row.title,
        context: row.fork_context ?? null,
        copiedMessageCount: row.fork_message_count ?? 0,
      }
    : null;
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
      // A tool still waiting for its service to connect never ran.
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

function tryParseMetadata(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // Older or malformed metadata must not hide the message itself.
    return undefined;
  }
}

// A window that doesn't own the conversation (another runs its turn or holds
// its question) shows the turn as saved, its question still to be answered there.
function messageFromRow(row: AgentMessageRow, recover: boolean): Message {
  const metadata = tryParseMetadata(row.metadata);
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

export function decodeChatMessages(row: StoredChatConversation, recover = true): Message[] {
  return row.messages.map((message) => messageFromRow(message, recover));
}

/** What a saved reply carries besides its text. */
export function replyMetadata(
  toolCalls: ToolCallInfo[] | undefined,
  turn: AssistantTurn | undefined
): Record<string, unknown> | undefined {
  return toolCalls?.length || turn
    ? {
        ...(toolCalls?.length ? { toolCalls: withoutSkillCardDrafts(toolCalls) } : {}),
        ...(turn ? { turn } : {}),
      }
    : undefined;
}

/**
 * Saves a reply into the row it was saved in while it waited on the user, or
 * adds it. Its row id, or null when it couldn't be added.
 */
export async function saveReplyRow(
  conversationId: number,
  rowId: number | null | undefined,
  content: string,
  metadata: Record<string, unknown> | undefined
): Promise<number | null> {
  // A saved reply keeps its row: one that is gone is never added again.
  if (rowId != null) {
    try {
      await window.electronAPI?.updateAgentMessage?.(rowId, content, metadata);
    } catch (error) {
      logger.warn("Unable to update saved reply", { error }, "chat");
    }
    return rowId;
  }
  const row = await window.electronAPI?.addAgentMessage?.(
    conversationId,
    "assistant",
    content,
    metadata
  );
  return row?.id ?? null;
}

/** Adds a message to a conversation that must still exist; its row id. */
export async function appendChatMessage(
  conversationId: number,
  role: "user" | "assistant",
  content: string,
  metadata?: Record<string, unknown>
): Promise<number> {
  const result = await window.electronAPI?.addAgentMessage?.(
    conversationId,
    role,
    content,
    metadata
  );
  if (!result) throw new Error("Conversation is no longer available");
  return result.id;
}
