import type { Message, ToolCallInfo } from "./types";
import { withoutSkillCardDrafts } from "./skillCardRecord";

export type StoredChatConversation = NonNullable<
  Awaited<ReturnType<NonNullable<Window["electronAPI"]["getAgentConversation"]>>>
>;

export function decodeChatMessages(row: StoredChatConversation): Message[] {
  return row.messages.map((message) => {
    let toolCalls: ToolCallInfo[] | undefined;
    try {
      const metadata: { toolCalls?: ToolCallInfo[] } = JSON.parse(message.metadata ?? "{}");
      toolCalls = metadata?.toolCalls;
    } catch {
      // Older or malformed metadata must not hide the message itself.
    }
    return {
      id: crypto.randomUUID(),
      role: message.role as Message["role"],
      content: message.content,
      isStreaming: false,
      ...(toolCalls ? { toolCalls } : {}),
    };
  });
}

export async function appendChatMessage(
  conversationId: number,
  role: "user" | "assistant",
  content: string,
  toolCalls?: ToolCallInfo[]
): Promise<void> {
  const result = await window.electronAPI?.addAgentMessage?.(
    conversationId,
    role,
    content,
    toolCalls?.length ? { toolCalls: withoutSkillCardDrafts(toolCalls) } : undefined
  );
  if (!result) throw new Error("Conversation is no longer available");
}
