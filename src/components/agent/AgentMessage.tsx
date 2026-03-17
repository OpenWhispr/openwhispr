import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "../lib/utils";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";

interface AgentMessageProps {
  role: "user" | "assistant";
  content: string;
  isStreaming: boolean;
}

export function AgentMessage({ role, content, isStreaming }: AgentMessageProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  if (role === "user") {
    return (
      <div
        className="flex justify-end"
        style={{ animation: "agent-message-in 200ms ease-out both" }}
      >
        <div
          className={cn(
            "max-w-[85%] px-3 py-2 rounded-lg rounded-br-sm",
            "bg-primary/90 text-primary-foreground",
            "text-[13px] leading-relaxed"
          )}
        >
          {content}
        </div>
      </div>
    );
  }

  return (
    <div
      className="group/msg flex justify-start"
      style={{ animation: "agent-message-in 200ms ease-out both" }}
    >
      <div
        className={cn(
          "relative max-w-[85%] px-3 py-2 rounded-lg rounded-bl-sm",
          "bg-surface-2 border border-border/30 text-foreground",
          "text-[13px] leading-relaxed"
        )}
      >
        <button
          onClick={handleCopy}
          className={cn(
            "absolute top-1.5 right-1.5 p-1 rounded-sm",
            "text-muted-foreground hover:text-foreground hover:bg-foreground/10",
            "opacity-0 group-hover/msg:opacity-100 transition-opacity duration-150",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
          )}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>

        <MarkdownRenderer
          content={content}
          className="text-[13px] leading-relaxed [&_p]:text-[13px] [&_li]:text-[13px]"
        />

        {isStreaming && (
          <span
            className="inline-block w-[2px] h-[14px] bg-foreground align-middle ml-0.5"
            style={{ animation: "agent-cursor-blink 800ms steps(1) infinite" }}
          />
        )}
      </div>
    </div>
  );
}
