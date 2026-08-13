import { useCallback } from "react";
import type { ChatPersistence } from "./useChatPersistence";
import type { ChatStreaming } from "./useChatStreaming";
import type { Message } from "./types";

interface PersistedMessageContext {
  conversationId: number;
  text: string;
  isFirstMessage: boolean;
}

interface UseChatMessageSenderOptions {
  conversationId: number | null;
  persistence: ChatPersistence;
  streaming: Pick<ChatStreaming, "sendToAI">;
  createConversation: (text: string) => Promise<number>;
  onBeforeSend?: () => void;
  onMessagePersisted?: (context: PersistedMessageContext) => void | Promise<void>;
}

export function useChatMessageSender({
  conversationId,
  persistence,
  streaming,
  createConversation,
  onBeforeSend,
  onMessagePersisted,
}: UseChatMessageSenderOptions): (text: string) => Promise<void> {
  return useCallback(
    async (text: string) => {
      onBeforeSend?.();
      const convId = conversationId ?? (await createConversation(text));
      const previousMessages = persistence.messages;
      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        isStreaming: false,
      };

      persistence.setMessages((messages) => [...messages, userMessage]);
      await persistence.saveUserMessage(text);
      await onMessagePersisted?.({
        conversationId: convId,
        text,
        isFirstMessage: previousMessages.length === 0,
      });
      await streaming.sendToAI(text, [...previousMessages, userMessage]);
    },
    [conversationId, createConversation, onBeforeSend, onMessagePersisted, persistence, streaming]
  );
}
