import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, X } from "lucide-react";
import { cn } from "../lib/utils";
import { BrandMarkIcon } from "./BrandMarkIcon";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { Button } from "../ui/button";
import { useChatPersistence } from "../chat/useChatPersistence";
import { useChatStreaming } from "../chat/useChatStreaming";
import { useChatMessageSender } from "../chat/useChatMessageSender";
import { useWindowDrag } from "../../hooks/useWindowDrag";
import { useSettingsStore } from "../../stores/settingsStore";
import { formatHotkeyListLabel } from "../../utils/hotkeys";
import type { AgentState, ChatImageAttachment } from "../chat/types";
import { ExpandingPanelShell } from "./ExpandingPanelShell";

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
  /** Keeps follow-up thinking feedback inside an already-open panel. */
  thinking: boolean;
  open: boolean;
  onClose: () => void;
  onResponseReadyChange: (ready: boolean) => void;
  onResponseContent: () => void;
}

const BUSY_STATES: AgentState[] = ["thinking", "streaming", "tool-executing"];

export function AssistantPanel({
  pendingCommand,
  onCommandConsumed,
  initialConversationId,
  onConversationIdChange,
  voiceState,
  thinking,
  open,
  onClose,
  onResponseReadyChange,
  onResponseContent,
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
    onResponseContent,
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

  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const responseContent = latestAssistantMessage?.content ?? "";
  const isResponseReady = Boolean(
    responseContent && !isBusy && !latestAssistantMessage?.isStreaming && voiceState === "idle"
  );
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onResponseReadyChange(isResponseReady);
  }, [isResponseReady, onResponseReadyChange]);

  useEffect(() => {
    setCopied(false);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, [responseContent]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const handleCopy = useCallback(async () => {
    const textToCopy = responseContent.trim();
    if (!textToCopy) return;

    try {
      const result = await window.electronAPI?.writeClipboard?.(textToCopy);
      if (result?.success === false) throw new Error("clipboard-write-failed");
    } catch {
      try {
        await navigator.clipboard.writeText(textToCopy);
      } catch {
        setCopied(false);
        return;
      }
    }

    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1800);
  }, [responseContent]);

  // Esc cancels a running response or closes the panel. The screenshot's
  // compact `C` hint is also a keyboard shortcut once a response is final.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (voiceState === "listening") return;
        if (isBusy) {
          streaming.cancelStream();
          // A hidden panel means the compact Beam circle owns the thinking
          // state; cancelling it must also dismiss that otherwise-idle shell.
          if (!open) onClose();
        } else onClose();
        return;
      }

      const target = e.target as HTMLElement | null;
      const isEditable =
        target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (
        isResponseReady &&
        e.key.toLowerCase() === "c" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditable
      ) {
        e.preventDefault();
        void handleCopy();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [voiceState, isBusy, streaming, open, onClose, isResponseReady, handleCopy]);

  return (
    <ExpandingPanelShell open={open} anchor="bottom-right">
      <header
        className="flex h-16 shrink-0 cursor-grab items-center gap-3 px-5 active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border/50 bg-surface-1 text-muted-foreground shadow-[var(--shadow-card)]">
          <BrandMarkIcon size={16} />
        </div>

        <div className="min-w-0 flex-1 text-right font-mono text-xs tracking-wide text-muted-foreground/70">
          <span className="truncate">{t("assistant.panel.selectionHint")}</span>
          {readableVoiceHotkey && (
            <kbd className="ml-2 inline-flex rounded-md border border-border/40 bg-foreground/5 px-2 py-1 font-mono text-[11px] tracking-normal text-foreground/65 shadow-sm">
              {readableVoiceHotkey}
            </kbd>
          )}
        </div>
      </header>

      <main
        className={cn(
          "mx-4 min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border/40 bg-surface-1 px-5 py-4 shadow-inner agent-chat-scroll",
          thinking && "agent-thinking-text-window"
        )}
        aria-busy={thinking}
      >
        <div>
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
          ) : null}
        </div>
      </main>

      <footer className="flex h-16 shrink-0 items-center justify-end gap-2 px-4">
        {isResponseReady && (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-full px-4"
              onClick={onClose}
            >
              <X aria-hidden="true" />
              {t("common.close")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="rounded-full px-4"
              onClick={() => void handleCopy()}
              aria-live="polite"
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? t("common.copied") : t("assistant.panel.copyToClipboard")}
              {!copied && (
                <kbd className="ml-1 rounded bg-primary-foreground/15 px-1.5 py-0.5 font-mono text-[10px] font-medium">
                  C
                </kbd>
              )}
            </Button>
          </>
        )}
      </footer>
    </ExpandingPanelShell>
  );
}
