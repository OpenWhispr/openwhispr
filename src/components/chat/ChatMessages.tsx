import { useRef, useEffect } from "react";
import { cn } from "../lib/utils";
import { ChatMessage } from "./ChatMessage";
import type { Message } from "./types";

interface ChatMessagesProps {
  messages: Message[];
  emptyState?: React.ReactNode;
  onOpenNote?: (noteId: number) => void;
}

export function ChatMessages({ messages, emptyState, onOpenNote }: ChatMessagesProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  return (
    <div ref={scrollRef} className={cn("flex-1 overflow-y-auto agent-chat-scroll", "px-3 py-2")}>
      {messages.length === 0 ? (
        (emptyState ?? null)
      ) : (
        <div className="flex flex-col gap-1.5">
          {messages
            .filter((msg) => msg.role !== "tool")
            .map((msg) => (
              <ChatMessage
                key={msg.id}
                role={msg.role as "user" | "assistant"}
                content={msg.content}
                isStreaming={msg.isStreaming}
                toolCalls={msg.toolCalls}
                onOpenNote={onOpenNote}
              />
            ))}
        </div>
      )}
    </div>
  );
}
