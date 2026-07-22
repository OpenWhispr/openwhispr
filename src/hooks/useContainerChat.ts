import { useState, useCallback, useEffect, useMemo } from "react";
import { useChatPersistence } from "../components/chat/useChatPersistence";
import { useChatStreaming, type ChatSearchScope } from "../components/chat/useChatStreaming";
import type { Message, AgentState } from "../components/chat/types";
import type { SpaceItem, FolderItem, NoteItem } from "../types/electron";

const MAX_CONTEXT_NOTES = 12;
const NOTE_SNIPPET_LENGTH = 600;

interface UseContainerChatOptions {
  space: SpaceItem;
  folder: FolderItem | null;
  notes: NoteItem[];
}

interface ContainerConversationItem {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface UseContainerChatReturn {
  messages: Message[];
  agentState: AgentState;
  sendMessage: (text: string) => Promise<void>;
  cancelStream: () => void;
  conversations: ContainerConversationItem[];
  activeConversationId: number | null;
  switchConversation: (id: number) => Promise<void>;
  startNewChat: () => void;
}

/**
 * Chat scoped to a space or folder (container overview). The host component
 * remounts per container (key prop), so this hook always starts with a fresh
 * ask box; past container conversations are reachable via the picker.
 */
export function useContainerChat({
  space,
  folder,
  notes,
}: UseContainerChatOptions): UseContainerChatReturn {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [conversations, setConversations] = useState<ContainerConversationItem[]>([]);
  const folderId = folder?.id ?? null;

  const persistence = useChatPersistence({
    onConversationCreated: (id) => setConversationId(id),
  });

  const containerContext = useMemo(() => {
    const header = folder
      ? `The user is viewing the folder "${folder.name}" in the space "${space.name}" (${notes.length} notes).`
      : `The user is viewing the space "${space.name}" (${notes.length} notes).`;
    const noteBlocks = notes.slice(0, MAX_CONTEXT_NOTES).map((note) => {
      const body = (note.enhanced_content || note.content || "").slice(0, NOTE_SNIPPET_LENGTH);
      return `<note id="${note.id}" title="${note.title}" updated="${note.updated_at}">\n${body}\n</note>`;
    });
    return [header, ...noteBlocks].join("\n\n");
  }, [folder, space.name, notes]);

  const searchScope = useMemo<ChatSearchScope>(
    () => ({ spaceId: space.id, folderId }),
    [space.id, folderId]
  );

  const streaming = useChatStreaming({
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    noteContext: containerContext,
    searchScope,
    onStreamComplete: (_id, content, toolCalls) => {
      persistence.saveAssistantMessage(content, toolCalls);
    },
  });

  const fetchConversations = useCallback(async () => {
    const list = await window.electronAPI?.getConversationsForContainer?.(space.id, folderId);
    setConversations(list ?? []);
  }, [space.id, folderId]);

  useEffect(() => {
    let stale = false;
    (async () => {
      const list = await window.electronAPI?.getConversationsForContainer?.(space.id, folderId);
      if (!stale) setConversations(list ?? []);
    })();
    return () => {
      stale = true;
    };
  }, [space.id, folderId]);

  const switchConversation = useCallback(
    async (id: number) => {
      await persistence.loadConversation(id);
      setConversationId(id);
    },
    [persistence]
  );

  const startNewChat = useCallback(() => {
    persistence.handleNewChat();
    setConversationId(null);
  }, [persistence]);

  const sendMessage = useCallback(
    async (text: string) => {
      let convId = conversationId;
      if (!convId) {
        const title = folder?.name ?? space.name;
        convId = await persistence.createConversation(title, null, {
          spaceId: space.id,
          folderId,
        });
        fetchConversations();
      }

      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        isStreaming: false,
      };
      persistence.setMessages((prev) => [...prev, userMsg]);
      await persistence.saveUserMessage(text);

      const allMessages = [...persistence.messages, userMsg];
      await streaming.sendToAI(text, allMessages);
    },
    [conversationId, folder, folderId, space.id, space.name, persistence, streaming, fetchConversations]
  );

  return {
    messages: persistence.messages,
    agentState: streaming.agentState,
    sendMessage,
    cancelStream: streaming.cancelStream,
    conversations,
    activeConversationId: conversationId,
    switchConversation,
    startNewChat,
  };
}
