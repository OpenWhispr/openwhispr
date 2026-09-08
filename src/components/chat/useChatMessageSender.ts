import { useCallback, useRef } from "react";
import type { ChatPersistence } from "./useChatPersistence";
import type { ChatStreaming, SendToAIOptions } from "./useChatStreaming";
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
  onSendingChange?: (sending: boolean) => void;
}

export interface MessageSubmissionLock {
  run: (operation: () => Promise<void>) => Promise<boolean>;
}

export function createMessageSubmissionLock(): MessageSubmissionLock {
  let active = false;

  return {
    async run(operation: () => Promise<void>): Promise<boolean> {
      if (active) return false;
      active = true;
      try {
        await operation();
        return true;
      } finally {
        active = false;
      }
    },
  };
}

export function useChatMessageSender({
  conversationId,
  persistence,
  streaming,
  createConversation,
  onBeforeSend,
  onMessagePersisted,
  onSendingChange,
}: UseChatMessageSenderOptions): (text: string, options?: SendToAIOptions) => Promise<boolean> {
  const submissionLockRef = useRef<MessageSubmissionLock | null>(null);
  if (submissionLockRef.current === null) {
    submissionLockRef.current = createMessageSubmissionLock();
  }

  return useCallback(
    async (text: string, options?: SendToAIOptions) => {
      return await submissionLockRef.current!.run(async () => {
        onSendingChange?.(true);
        try {
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
          await streaming.sendToAI(text, [...previousMessages, userMessage], options);
        } finally {
          onSendingChange?.(false);
        }
      });
    },
    [
      conversationId,
      createConversation,
      onBeforeSend,
      onMessagePersisted,
      onSendingChange,
      persistence,
      streaming,
    ]
  );
}
