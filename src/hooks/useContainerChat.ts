import { useState, useCallback, useEffect, useMemo } from "react";
import { useChatPersistence } from "../components/chat/useChatPersistence";
import { useChatStreaming } from "../components/chat/useChatStreaming";
import { useChatMessageSender } from "../components/chat/useChatMessageSender";
import type { Message, AgentState } from "../components/chat/types";
import { deriveConversationTitle } from "../lib/conversationTitle";
import type { SpaceItem, FolderItem, NoteItem } from "../types/electron";
import type { ContainerScope } from "../types/chat";

const MAX_CONTEXT_NOTES = 12;
const NOTE_SNIPPET_LENGTH = 600;

interface UseContainerChatOptions {
  space: SpaceItem;
  folder: FolderItem | null;
  notes: NoteItem[];
}

export interface ContainerConversationItem {
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
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
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

  const searchScope = useMemo<ContainerScope>(
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

  const fetchConversations = useCallback(
    async (isStale?: () => boolean): Promise<void> => {
      let list: ContainerConversationItem[];
      try {
        list = (await window.electronAPI?.getConversationsForContainer?.(space.id, folderId)) ?? [];
      } catch {
        list = [];
      }
      if (!isStale?.()) setConversations(list);
    },
    [space.id, folderId]
  );

  useEffect(() => {
    let stale = false;
    void fetchConversations(() => stale);
    return () => {
      stale = true;
    };
  }, [fetchConversations]);

  // useChatStreaming returns a fresh object every render; cancelStream is
  // stable. Leaving a conversation cancels its turn, as in useEmbeddedChat: a
  // reply still streaming would otherwise save into whichever conversation is
  // open when it settles.
  const { cancelStream } = streaming;

  const switchConversation = useCallback(
    async (id: number) => {
      if (id === conversationId) return;
      cancelStream();
      await persistence.loadConversation(id);
      setConversationId(id);
    },
    [cancelStream, conversationId, persistence]
  );

  const startNewChat = useCallback(() => {
    cancelStream();
    persistence.handleNewChat();
    setConversationId(null);
  }, [cancelStream, persistence]);

  const createConversation = useCallback(
    async (text: string) => {
      const title = deriveConversationTitle(text, folder?.name ?? space.name);
      const id = await persistence.createConversation(title, null, {
        spaceId: space.id,
        folderId,
      });
      void fetchConversations();
      return id;
    },
    [fetchConversations, folder, folderId, persistence, space.id, space.name]
  );
  const sendMessageWithResult = useChatMessageSender({
    conversationId,
    persistence,
    streaming,
    createConversation,
    onSendingChange: setSubmissionInFlight,
  });
  const sendMessage = useCallback(
    async (text: string): Promise<void> => {
      await sendMessageWithResult(text);
    },
    [sendMessageWithResult]
  );

  return {
    messages: persistence.messages,
    // As in ChatView: the send lock is held while a first send creates its
    // conversation, and after Stop, New chat or a switch until an in-flight tool
    // returns; it would drop a message sent meanwhile, so the chat reads busy
    // until it lets go.
    agentState:
      submissionInFlight && streaming.agentState === "idle" ? "thinking" : streaming.agentState,
    sendMessage,
    cancelStream,
    conversations,
    activeConversationId: conversationId,
    switchConversation,
    startNewChat,
  };
}
