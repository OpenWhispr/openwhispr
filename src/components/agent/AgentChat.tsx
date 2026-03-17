import { useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { AgentMessage } from "./AgentMessage";
import { useSettingsStore } from "../../stores/settingsStore";
import { formatHotkeyLabel } from "../../utils/hotkeys";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  isStreaming: boolean;
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
        <div className="flex items-center justify-center h-full">
          <p className="text-[12px] text-muted-foreground/60 text-center select-none">
            {t("agentMode.chat.emptyState", { hotkey: hotkeyLabel })}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {messages.map((msg) => (
            <AgentMessage
              key={msg.id}
              role={msg.role}
              content={msg.content}
              isStreaming={msg.isStreaming}
            />
          ))}
        </div>
      )}
    </div>
  );
}
