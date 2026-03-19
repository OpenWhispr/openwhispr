import { useRef, useEffect } from "react";
import { Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { AgentMessage } from "./AgentMessage";
import { useSettingsStore } from "../../stores/settingsStore";
import { formatHotkeyLabel } from "../../utils/hotkeys";

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  status: "executing" | "completed" | "error";
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  isStreaming: boolean;
  toolCalls?: ToolCallInfo[];
}

interface AgentChatProps {
  messages: Message[];
}

export function AgentChat({ messages }: AgentChatProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const agentKey = useSettingsStore((s) => s.agentKey);
  const hotkeyLabel = formatHotkeyLabel(agentKey);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  return (
    <div ref={scrollRef} className={cn("flex-1 overflow-y-auto agent-chat-scroll", "px-3 py-2")}>
      {messages.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-2 select-none">
          <div
            className="text-muted-foreground/30"
            style={{ animation: "agent-mic-pulse 3s ease-in-out infinite" }}
          >
            <Mic size={20} />
          </div>
          <div className="text-center">
            <p className="text-[12px] text-muted-foreground/50">
              {t("agentMode.chat.emptyState", { hotkey: hotkeyLabel })}
            </p>
            <p className="text-[11px] text-muted-foreground/30 mt-0.5">
              {t("agentMode.chat.orType")}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {messages
            .filter((msg) => msg.role !== "tool")
            .map((msg) => (
              <AgentMessage
                key={msg.id}
                role={msg.role as "user" | "assistant"}
                content={msg.content}
                isStreaming={msg.isStreaming}
                toolCalls={msg.toolCalls}
              />
            ))}
        </div>
      )}
    </div>
  );
}
