import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useChatPersistence } from "../components/chat/useChatPersistence";
import { useChatStreaming } from "../components/chat/useChatStreaming";
import { useChatMessageSender } from "../components/chat/useChatMessageSender";
import type { Message, AgentState } from "../components/chat/types";

interface UseEmbeddedChatOptions {
  noteId: number | null;
  folderId: number | null;
  noteTitle: string;
  noteContent: string;
  noteTranscript?: string;
}

interface NoteConversationItem {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface UseEmbeddedChatReturn {
  messages: Message[];
  agentState: AgentState;
  sendMessage: (text: string) => Promise<void>;
  cancelStream: () => void;
  noteConversations: NoteConversationItem[];
  activeConversationId: number | null;
  switchConversation: (id: number) => Promise<void>;
  startNewChat: () => void;
}

export function useEmbeddedChat({
  noteId,
  folderId,
  noteTitle,
  noteContent,
  noteTranscript,
}: UseEmbeddedChatOptions): UseEmbeddedChatReturn {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [noteConversations, setNoteConversations] = useState<NoteConversationItem[]>([]);
  const noteIdRef = useRef(noteId);
  const [prevNoteId, setPrevNoteId] = useState(noteId);

  const persistence = useChatPersistence({
    conversationId,
    onConversationCreated: (id) => {
      setConversationId(id);
    },
  });

  const noteContext = useMemo(
    () =>
      [
        `Note ID: ${noteId}`,
        folderId != null ? `Folder ID: ${folderId}` : "",
        `Title: ${noteTitle}`,
        `Content:\n${noteContent}`,
        noteTranscript ? `\nTranscript:\n${noteTranscript}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    [folderId, noteContent, noteId, noteTitle, noteTranscript]
  );

  const streaming = useChatStreaming({
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    noteContext,
    onStreamComplete: (_id, content, toolCalls) => {
      persistence.saveAssistantMessage(content, toolCalls);
    },
  });

  const fetchNoteConversations = useCallback(async () => {
    if (!noteId) return;
    const conversations = await window.electronAPI?.getConversationsForNote?.(noteId);
    if (noteIdRef.current !== noteId) return;
    setNoteConversations(conversations ?? []);
    return conversations ?? [];
  }, [noteId]);

  if (noteId !== prevNoteId) {
    setPrevNoteId(noteId);
    if (!noteId) {
      persistence.handleNewChat();
      setConversationId(null);
      setNoteConversations([]);
    }
  }

  useEffect(() => {
    noteIdRef.current = noteId;
    if (!noteId) return;

    let stale = false;
    (async () => {
      const conversations = await window.electronAPI?.getConversationsForNote?.(noteId);
      if (stale || noteIdRef.current !== noteId) return;
      setNoteConversations(conversations ?? []);
      if (conversations?.length) {
        const mostRecent = conversations[0];
        await persistence.loadConversation(mostRecent.id);
        if (stale || noteIdRef.current !== noteId) return;
        setConversationId(mostRecent.id);
      } else {
        persistence.handleNewChat();
        setConversationId(null);
      }
    })();

    return () => {
      stale = true;
    };
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const createConversation = useCallback(
    async (text: string) => {
      const id = await persistence.createConversation(`Note: ${noteTitle || "Untitled"}`, noteId);
      void fetchNoteConversations();
      return id;
    },
    [fetchNoteConversations, noteId, noteTitle, persistence]
  );
  const sendMessage = useChatMessageSender({
    conversationId,
    persistence,
    streaming,
    createConversation,
  });

  return {
    messages: persistence.messages,
    agentState: streaming.agentState,
    sendMessage,
    cancelStream: streaming.cancelStream,
    noteConversations,
    activeConversationId: conversationId,
    switchConversation,
    startNewChat,
  };
}
