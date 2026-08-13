import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, SquarePen, X } from "lucide-react";
import { cn } from "../lib/utils";
import { BrandMarkIcon } from "./BrandMarkIcon";
import { ChatMessages } from "../chat/ChatMessages";
import { ChatInput } from "../chat/ChatInput";
import { useChatPersistence } from "../chat/useChatPersistence";
import { useChatStreaming } from "../chat/useChatStreaming";
import { useChatMessageSender } from "../chat/useChatMessageSender";
import { useWindowDrag } from "../../hooks/useWindowDrag";
import type { AgentState, ChatImageAttachment } from "../chat/types";

export interface AssistantCommand {
  id: number;
  text: string;
  attachment: ChatImageAttachment | null;
}

interface AssistantPanelProps {
  /** Voice command waiting to be sent into the conversation (consumed on mount and on change). */
  pendingCommand: AssistantCommand | null;
  onCommandConsumed: (id: number) => void;
  /** Conversation to resume when reopening the panel; null starts fresh on first message. */
  initialConversationId: number | null;
  onConversationIdChange: (id: number | null) => void;
  /** Live voice state while the user records a follow-up with the panel open. */
  voiceState: Extract<AgentState, "idle" | "listening" | "transcribing">;
  partialTranscript: string;
  onClose: () => void;
}

const BUSY_STATES: AgentState[] = ["thinking", "streaming", "tool-executing"];

export function AssistantPanel({
  pendingCommand,
  onCommandConsumed,
  initialConversationId,
  onConversationIdChange,
  voiceState,
  partialTranscript,
  onClose,
}: AssistantPanelProps) {
  const { t } = useTranslation();
  const { handleMouseDown, handleMouseUp } = useWindowDrag();
  const [copied, setCopied] = useState(false);

  const persistence = useChatPersistence({ conversationId: initialConversationId });
  const { messages, setMessages } = persistence;

  const streaming = useChatStreaming({
    messages,
    setMessages,
    onStreamComplete: (_assistantId, content, toolCalls) => {
      persistence.saveAssistantMessage(content, toolCalls);
    },
  });

  const createConversation = useCallback(
    (text: string) => {
      const title = text.slice(0, 50) + (text.length > 50 ? "..." : "");
      return persistence.createConversation(title);
    },
    [persistence]
  );

  const sendMessage = useChatMessageSender({
    conversationId: persistence.conversationId,
    persistence,
    streaming,
    createConversation,
  });

  useEffect(() => {
    onConversationIdChange(persistence.conversationId);
  }, [persistence.conversationId, onConversationIdChange]);

  // Reopening the panel resumes the previous conversation.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!loadedRef.current && initialConversationId != null) {
      persistence.loadConversation(initialConversationId);
    }
    loadedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Voice commands arrive as pending commands: send each exactly once.
  const consumedCommandIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!pendingCommand || consumedCommandIdRef.current === pendingCommand.id) return;
    consumedCommandIdRef.current = pendingCommand.id;
    onCommandConsumed(pendingCommand.id);
    sendMessage(pendingCommand.text, { attachment: pendingCommand.attachment ?? undefined });
  }, [pendingCommand, onCommandConsumed, sendMessage]);

  const isBusy = BUSY_STATES.includes(streaming.agentState);

  // Esc: an active follow-up recording is cancelled by the recording cancel
  // hotkey, so ignore it here; otherwise stop a running stream, then collapse.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (voiceState === "listening") return;
      if (isBusy) {
        streaming.cancelStream();
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [voiceState, isBusy, streaming, onClose]);

  const lastAssistantText = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && !m.isStreaming && m.content)?.content;

  const handleCopy = useCallback(async () => {
    if (!lastAssistantText) return;
    await navigator.clipboard.writeText(lastAssistantText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [lastAssistantText]);

  const handleNewChat = useCallback(() => {
    streaming.cancelStream();
    persistence.handleNewChat();
    onConversationIdChange(null);
  }, [streaming, persistence, onConversationIdChange]);

  const handleTextSubmit = useCallback(
    (text: string) => {
      if (text.trim()) sendMessage(text);
    },
    [sendMessage]
  );

  const agentState: AgentState = voiceState !== "idle" ? voiceState : streaming.agentState;

  const suggestions = [
    t("assistant.panel.suggestionDraft"),
    t("assistant.panel.suggestionSummarize"),
    t("assistant.panel.suggestionCalendar"),
  ];

  return (
    <div
      className={cn(
        "absolute inset-2 flex flex-col overflow-hidden",
        "rounded-2xl border border-border/50 bg-surface-0",
        "shadow-[var(--shadow-elevated)]"
      )}
      style={{
        animation: "assistant-panel-in 240ms cubic-bezier(0.2, 0, 0, 1)",
        transformOrigin: "bottom center",
      }}
    >
      <div
        className="flex h-10 shrink-0 cursor-grab items-center justify-between px-3 active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      >
        <BrandMarkIcon size={18} className="text-foreground/70" />
        <button
          aria-label={t("assistant.panel.newChat")}
          onClick={handleNewChat}
          onMouseDown={(e) => e.stopPropagation()}
          className={cn(
            "rounded-sm p-1 text-muted-foreground/60 transition-colors duration-100",
            "hover:bg-foreground/8 hover:text-foreground",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
          )}
        >
          <SquarePen size={14} />
        </button>
      </div>

      <ChatMessages
        messages={messages}
        emptyState={
          <div className="flex h-full flex-col items-center justify-center gap-3 select-none">
            <p className="text-xs text-foreground/40">{t("assistant.panel.emptyHint")}</p>
            <div className="flex flex-col items-center gap-1.5">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => sendMessage(suggestion)}
                  className={cn(
                    "rounded-full border border-border/50 px-3 py-1 text-[11px] text-foreground/70",
                    "transition-colors duration-100 hover:bg-muted hover:text-foreground",
                    "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
                  )}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        }
      />

      <div className="shrink-0 px-3 pb-3 pt-1">
        <ChatInput
          agentState={agentState}
          partialTranscript={partialTranscript}
          onTextSubmit={handleTextSubmit}
          onCancel={streaming.cancelStream}
          autoFocus
          placeholder={t("assistant.panel.askFollowUp")}
          className="pb-2"
        />
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium",
              "bg-muted text-foreground/80 transition-colors duration-100",
              "hover:bg-foreground/10 hover:text-foreground",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
            )}
          >
            <X size={12} strokeWidth={2.5} />
            {t("assistant.panel.close")}
          </button>
          <button
            onClick={handleCopy}
            disabled={!lastAssistantText}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium",
              "transition-colors duration-100",
              "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40",
              lastAssistantText
                ? "bg-foreground text-background hover:bg-foreground/85"
                : "cursor-default bg-muted text-muted-foreground/40"
            )}
          >
            {copied ? <Check size={12} strokeWidth={2.5} /> : <Copy size={12} />}
            {copied ? t("assistant.panel.copied") : t("assistant.panel.copyToClipboard")}
          </button>
        </div>
      </div>
    </div>
  );
}
