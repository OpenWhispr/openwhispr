import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { BrandMarkIcon } from "./BrandMarkIcon";
import { VoicePill, type VoicePillState } from "./VoicePill";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { useChatPersistence } from "../chat/useChatPersistence";
import { useChatStreaming } from "../chat/useChatStreaming";
import { useChatMessageSender } from "../chat/useChatMessageSender";
import { useWindowDrag } from "../../hooks/useWindowDrag";
import { useSettingsStore } from "../../stores/settingsStore";
import { formatHotkeyListLabel } from "../../utils/hotkeys";
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
  getAudioLevel: () => number | null;
  onClose: () => void;
}

const BUSY_STATES: AgentState[] = ["thinking", "streaming", "tool-executing"];

export function AssistantPanel({
  pendingCommand,
  onCommandConsumed,
  initialConversationId,
  onConversationIdChange,
  voiceState,
  getAudioLevel,
  onClose,
}: AssistantPanelProps) {
  const { t } = useTranslation();
  const { handleMouseDown, handleMouseUp } = useWindowDrag();
  const voiceAgentKey = useSettingsStore((state) => state.voiceAgentKey);
  const readableVoiceHotkey = formatHotkeyListLabel(voiceAgentKey);

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

  // Reopening the panel resumes the previous conversation. Sends must wait
  // for the load: a command sent against the still-empty message list would
  // reach the model without the conversation's history, and the load's
  // setMessages would then wipe the just-sent turn from the UI.
  const [historyReady, setHistoryReady] = useState(initialConversationId == null);
  useEffect(() => {
    if (initialConversationId != null) {
      persistence.loadConversation(initialConversationId).finally(() => setHistoryReady(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Voice commands arrive as pending commands: send each exactly once.
  const consumedCommandIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!historyReady || !pendingCommand || consumedCommandIdRef.current === pendingCommand.id) {
      return;
    }
    consumedCommandIdRef.current = pendingCommand.id;
    onCommandConsumed(pendingCommand.id);
    sendMessage(pendingCommand.text, { attachment: pendingCommand.attachment ?? undefined });
  }, [historyReady, pendingCommand, onCommandConsumed, sendMessage]);

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

  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const responseContent = latestAssistantMessage?.content ?? "";
  const pillState: VoicePillState =
    voiceState === "listening"
      ? "recording"
      : voiceState === "transcribing"
        ? "processing"
        : "idle";
  const supportsViewTransitions =
    typeof document !== "undefined" && "startViewTransition" in document;

  return (
    <div
      className={cn(
        "absolute inset-3 flex flex-col overflow-hidden",
        "rounded-3xl border border-border/50 bg-surface-0 backdrop-blur-xl",
        "shadow-[var(--shadow-modal)]"
      )}
      style={{
        animation: supportsViewTransitions
          ? undefined
          : "assistant-panel-in 240ms cubic-bezier(0.2, 0, 0, 1)",
        transformOrigin: "bottom right",
        viewTransitionName: "assistant-panel",
      }}
    >
      <div
        className="flex h-16 shrink-0 cursor-grab items-center gap-3 px-5 active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      >
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/50 bg-surface-1 text-muted-foreground shadow-[var(--shadow-card)]">
          <BrandMarkIcon size={18} />
        </div>

        <div className="min-w-0 flex-1 text-right font-mono text-xs tracking-wide text-muted-foreground/70">
          <span className="truncate">{t("assistant.panel.selectionHint")}</span>
          {readableVoiceHotkey && (
            <kbd className="ml-2 inline-flex rounded-md border border-border/40 bg-foreground/5 px-2 py-1 font-mono text-[11px] tracking-normal text-foreground/65 shadow-sm">
              {readableVoiceHotkey}
            </kbd>
          )}
        </div>
      </div>

      <div className="mx-4 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border/40 bg-surface-1 px-5 py-4 shadow-inner agent-chat-scroll">
        {responseContent ? (
          <div style={{ animation: "agent-message-in 200ms ease-out both" }}>
            <MarkdownRenderer
              content={responseContent}
              className="text-[15px] leading-relaxed text-foreground [&_p]:text-[15px] [&_li]:text-[15px]"
            />
            {latestAssistantMessage?.isStreaming && (
              <span
                className="ml-0.5 inline-block h-4 w-0.5 align-middle bg-foreground/70"
                style={{ animation: "agent-cursor-blink 1s ease-in-out infinite" }}
              />
            )}
          </div>
        ) : isBusy ? (
          <span className="text-[15px] font-medium select-none thinking-shimmer-text">
            {t("agentMode.input.thinking")}...
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 justify-end px-4 py-4">
        <VoicePill
          variant="panel"
          state={pillState}
          getAudioLevel={getAudioLevel}
          aria-label={t("settingsPage.agentConfig.title")}
        />
      </div>
    </div>
  );
}
