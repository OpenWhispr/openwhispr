import { create } from "zustand";

interface ConversationItem {
  id: number;
  title: string;
  cloud_id?: string | null;
  client_conversation_id?: string | null;
  archived_at?: string | null;
  note_id?: number | null;
  created_at: string;
  updated_at: string;
}

interface ChatState {
  conversations: ConversationItem[];
  activeConversationId: number | null;
}

const useChatStore = create<ChatState>()(() => ({
  conversations: [],
  activeConversationId: null,
}));

export async function initializeConversations(limit = 50): Promise<ConversationItem[]> {
  const items = (await window.electronAPI?.getAgentConversations?.(limit)) ?? [];
  useChatStore.setState({ conversations: items });
  return items;
}

export function addConversation(conversation: ConversationItem): void {
  if (!conversation) return;
  const { conversations } = useChatStore.getState();
  const withoutDuplicate = conversations.filter((c) => c.id !== conversation.id);
  useChatStore.setState({ conversations: [conversation, ...withoutDuplicate] });
}

export function updateConversation(conversation: ConversationItem): void {
  if (!conversation) return;
  const { conversations } = useChatStore.getState();
  useChatStore.setState({
    conversations: conversations.map((c) => (c.id === conversation.id ? conversation : c)),
  });
}

export function removeConversation(id: number): void {
  if (id == null) return;
  const { conversations, activeConversationId } = useChatStore.getState();
  const next = conversations.filter((c) => c.id !== id);
  if (next.length === conversations.length) return;
  const update: Partial<ChatState> = { conversations: next };
  if (activeConversationId === id) {
    const idx = conversations.findIndex((c) => c.id === id);
    const neighbor = next[Math.min(idx, next.length - 1)] ?? null;
    update.activeConversationId = neighbor?.id ?? null;
  }
  useChatStore.setState(update);
}

export function setActiveConversationId(id: number | null): void {
  if (useChatStore.getState().activeConversationId === id) return;
  useChatStore.setState({ activeConversationId: id });
}

export function getActiveConversationIdValue(): number | null {
  return useChatStore.getState().activeConversationId;
}

export function useConversations(): ConversationItem[] {
  return useChatStore((state) => state.conversations);
}

export function useActiveConversationId(): number | null {
  return useChatStore((state) => state.activeConversationId);
}

export function useActiveConversation(): ConversationItem | null {
  return useChatStore((state) => {
    if (state.activeConversationId == null) return null;
    return state.conversations.find((c) => c.id === state.activeConversationId) ?? null;
  });
}

