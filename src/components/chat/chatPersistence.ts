import type { AssistantTurn, AssistantTurnStatus, Message, ToolCallInfo } from "./types";
import type { AgentConversationWithMessages, AgentMessageRow } from "../../types/electron";
import { withoutSkillCardDrafts } from "./skillCardRecord";

export type StoredChatConversation = AgentConversationWithMessages;

/** Where the open conversation was forked from. */
export interface ForkOrigin {
  parentConversationId: number;
  /** Null once the parent is deleted. */
  parentTitle: string | null;
  /** Text the fork was made from; it goes with the fork's next request. */
  context: string | null;
}

export function forkOriginOf(row: StoredChatConversation): ForkOrigin | null {
  return row.parent_conversation_id != null
    ? {
        parentConversationId: row.parent_conversation_id,
        parentTitle: row.parent_title ?? null,
        context: row.fork_context ?? null,
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

function messageFromRow(row: AgentMessageRow): Message {
  const metadata = tryParseMetadata(row.metadata);
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

export function decodeChatMessages(row: StoredChatConversation): Message[] {
  return row.messages.map(messageFromRow);
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
 * adds it. Its row id, or null when the conversation is gone.
 */
export async function saveReplyRow(
  conversationId: number,
  rowId: number | null | undefined,
  content: string,
  metadata: Record<string, unknown> | undefined
): Promise<number | null> {
  // A cloud pull can replace the rows, and the old id with them; the reply is then added again.
  if (rowId != null && (await window.electronAPI?.updateAgentMessage?.(rowId, content, metadata))) {
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
