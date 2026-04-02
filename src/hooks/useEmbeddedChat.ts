import { useState, useCallback, useEffect, useRef } from "react";
import { useChatPersistence } from "../components/chat/useChatPersistence";
import { useChatStreaming } from "../components/chat/useChatStreaming";
import type { Message, AgentState } from "../components/chat/types";

interface UseEmbeddedChatOptions {
  noteId: number | null;
  folderId: number | null;
  noteTitle: string;
  noteContent: string;
  noteTranscript?: string;
}

interface UseEmbeddedChatReturn {
  messages: Message[];
  agentState: AgentState;
  sendMessage: (text: string) => Promise<void>;
  cancelStream: () => void;
}

export function useEmbeddedChat({
  noteId,
  folderId,
  noteTitle,
  noteContent,
  noteTranscript,
}: UseEmbeddedChatOptions): UseEmbeddedChatReturn {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const noteIdRef = useRef(noteId);

  const persistence = useChatPersistence({
    conversationId,
    onConversationCreated: (id) => {
      setConversationId(id);
    },
  });

  const noteContextRef = useRef("");
  noteContextRef.current = [
    `Note ID: ${noteId}`,
    folderId != null ? `Folder ID: ${folderId}` : "",
    `Title: ${noteTitle}`,
    `Content:\n${noteContent}`,
    noteTranscript ? `\nTranscript:\n${noteTranscript}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const streaming = useChatStreaming({
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    noteContext: noteContextRef.current,
    onStreamComplete: (_id, content, toolCalls) => {
      persistence.saveAssistantMessage(content, toolCalls);
    },
  });

  // Reset chat when noteId changes
  useEffect(() => {
    if (noteId !== noteIdRef.current) {
      noteIdRef.current = noteId;
      persistence.handleNewChat();
      setConversationId(null);
    }
  }, [noteId, persistence]);

  const sendMessage = useCallback(
    async (text: string) => {
      let convId = conversationId;
      if (!convId) {
        const title = `Note: ${noteTitle || "Untitled"}`;
        convId = await persistence.createConversation(title);
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
    [conversationId, noteTitle, persistence, streaming]
  );

  return {
    messages: persistence.messages,
    agentState: streaming.agentState,
    sendMessage,
    cancelStream: streaming.cancelStream,
  };
}
