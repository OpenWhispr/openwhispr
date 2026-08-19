import { memo, useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, X } from "lucide-react";
import { BrandMarkIcon } from "./BrandMarkIcon";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { Button } from "../ui/button";
import { useChatPersistence } from "../chat/useChatPersistence";
import { useChatStreaming } from "../chat/useChatStreaming";
import { useChatMessageSender } from "../chat/useChatMessageSender";
import { useWindowDrag } from "../../hooks/useWindowDrag";
import { useSettingsStore } from "../../stores/settingsStore";
import { formatHotkeyListLabel } from "../../utils/hotkeys";
import {
  ASSISTANT_FOOTER_TRANSITION_TIMING,
  resolveAssistantFooterPresentation,
  resolveAssistantResponseReady,
} from "../../helpers/voicePillPresentation";
import {
  AGENT_TOOL_ACTIVITY_ROTATION_MS,
  AGENT_TOOL_ACTIVITY_VERBS,
  formatAgentToolName,
} from "../../helpers/agentToolPresentation";
import type { AgentState, ChatImageAttachment } from "../chat/types";
import {
  normalizeAgentSelectionContext,
  type AgentSelectionContext,
} from "../../utils/agentSelectionContext";

export interface AssistantCommand {
  id: number;
  text: string;
  attachment: ChatImageAttachment | null;
  selectedContext: AgentSelectionContext | null;
}

type AssistantFooterPhase =
  "pill" | "pill-entering" | "pill-exiting" | "actions-entering" | "actions" | "actions-exiting";

interface AssistantPanelProps {
  /** Voice command waiting to be sent into the conversation (consumed on mount and on change). */
  pendingCommand: AssistantCommand | null;
  onCommandConsumed: (id: number) => void;
  /** Conversation to resume when reopening the panel; null starts fresh on first message. */
  initialConversationId: number | null;
  /** Changes after a completed close so a still-mounted panel also drops its active session. */
  conversationResetToken: number;
  onConversationIdChange: (id: number | null) => void;
  /** Live voice state while the user records a follow-up with the panel open. */
  voiceState: Extract<AgentState, "idle" | "listening" | "transcribing">;
  /** Keeps follow-up thinking feedback inside an already-open panel. */
  thinking: boolean;
  open: boolean;
  footerPhase: AssistantFooterPhase;
  horizontalDirection: "left" | "right";
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onResponseReadyChange: (ready: boolean) => void;
  onResponseContent: () => void;
  onSelectionContextChange: (context: AgentSelectionContext | null) => void;
}

const BUSY_STATES: AgentState[] = ["thinking", "streaming", "tool-executing"];
// Updating the selection indicator must not rerender react-markdown: its
// component map is recreated on render, which remounts the text nodes and
// collapses the browser's live selection. Streaming content still rerenders
// normally because the content prop changes.
const StableAssistantMarkdown = memo(MarkdownRenderer);

export function AssistantPanel({
  pendingCommand,
  onCommandConsumed,
  initialConversationId,
  conversationResetToken,
  onConversationIdChange,
  voiceState,
  thinking,
  open,
  footerPhase,
  horizontalDirection,
  onClose,
  onBusyChange,
  onResponseReadyChange,
  onResponseContent,
  onSelectionContextChange,
}: AssistantPanelProps) {
  const { t } = useTranslation();
  const { handleMouseDown, handleMouseUp } = useWindowDrag();
  const voiceAgentKey = useSettingsStore((state) => state.voiceAgentKey);
  const readableVoiceHotkey = formatHotkeyListLabel(voiceAgentKey);

  const persistence = useChatPersistence({ conversationId: initialConversationId });
  const { messages, setMessages } = persistence;
  const handleNewChat = persistence.handleNewChat;

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
    if (pendingCommand.selectedContext) {
      setSelectedContext(null);
      onSelectionContextChange(null);
    }
    sendMessage(pendingCommand.text, {
      attachment: pendingCommand.attachment ?? undefined,
      selectedContext: pendingCommand.selectedContext ?? undefined,
    });
  }, [historyReady, pendingCommand, onCommandConsumed, onSelectionContextChange, sendMessage]);

  const isToolExecuting = Boolean(streaming.activeToolName);
  const isBusy = BUSY_STATES.includes(streaming.agentState) || isToolExecuting;
  const showContentFlourish = thinking || isToolExecuting;
  const [toolVerbIndex, setToolVerbIndex] = useState(0);
  const footerPresentation = resolveAssistantFooterPresentation(footerPhase);

  useEffect(() => {
    setToolVerbIndex(0);
    if (!isToolExecuting) return;

    const timer = window.setInterval(() => {
      setToolVerbIndex((current) => (current + 1) % AGENT_TOOL_ACTIVITY_VERBS.length);
    }, AGENT_TOOL_ACTIVITY_ROTATION_MS);
    return () => window.clearInterval(timer);
  }, [isToolExecuting, streaming.activeToolName]);

  useEffect(() => {
    onBusyChange(isBusy);
    return () => onBusyChange(false);
  }, [isBusy, onBusyChange]);

  const latestAssistantMessage = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");
  const responseContent = latestAssistantMessage?.content ?? "";
  const displayedResponseRef = useRef("");
  if (responseContent) displayedResponseRef.current = responseContent;
  const displayedResponse = responseContent || displayedResponseRef.current;
  // Keep the previous response ineligible throughout a follow-up request. Audio
  // processing can return voiceState to idle one render before the chat stream
  // reports busy; without this latch, the old response briefly restores the
  // Close/Copy actions and reverses the footer animation.
  const isResponseReady = resolveAssistantResponseReady({
    responseContent,
    isBusy,
    isStreaming: Boolean(latestAssistantMessage?.isStreaming),
    voiceState,
    requestPending: thinking || pendingCommand != null,
  });
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseSelectionRootRef = useRef<HTMLDivElement | null>(null);
  const [selectedContext, setSelectedContext] = useState<AgentSelectionContext | null>(null);

  const clearSelectedContext = useCallback(() => {
    setSelectedContext(null);
    onSelectionContextChange(null);
    window.getSelection()?.removeAllRanges();
  }, [onSelectionContextChange]);

  const handledConversationResetTokenRef = useRef(conversationResetToken);
  useEffect(() => {
    if (handledConversationResetTokenRef.current === conversationResetToken) return;
    handledConversationResetTokenRef.current = conversationResetToken;

    handleNewChat();
    displayedResponseRef.current = "";
    consumedCommandIdRef.current = null;
    clearSelectedContext();
    onConversationIdChange(null);
  }, [
    clearSelectedContext,
    conversationResetToken,
    onConversationIdChange,
    handleNewChat,
  ]);

  useEffect(() => {
    if (!open && selectedContext) clearSelectedContext();
  }, [clearSelectedContext, open, selectedContext]);

  useEffect(() => {
    if (!open || !isResponseReady || !latestAssistantMessage) return undefined;

    const captureSelection = () => {
      const selection = window.getSelection();
      const root = responseSelectionRootRef.current;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !root) return;

      const range = selection.getRangeAt(0);
      if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;

      const context = normalizeAgentSelectionContext({
        text: selection.toString(),
        sourceMessageId: latestAssistantMessage.id,
      });
      if (!context) return;

      setSelectedContext(context);
      onSelectionContextChange(context);
    };

    document.addEventListener("selectionchange", captureSelection);
    return () => document.removeEventListener("selectionchange", captureSelection);
  }, [isResponseReady, latestAssistantMessage, onSelectionContextChange, open]);

  useEffect(
    () => () => {
      onSelectionContextChange(null);
    },
    [onSelectionContextChange]
  );

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
        footerPhase === "actions" &&
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
  }, [voiceState, isBusy, streaming, open, onClose, isResponseReady, footerPhase, handleCopy]);

  return (
    <>
      <header
        className="flex h-16 shrink-0 cursor-grab items-center gap-3 px-5 active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      >
        <BrandMarkIcon size={20} className="shrink-0 text-muted-foreground" />

        <div className="flex min-w-0 flex-1 items-center justify-end text-right text-xs text-muted-foreground/70">
          {selectedContext ? (
            <div className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/55 bg-foreground/[0.06] py-1 pl-2.5 pr-1.5 text-foreground/75">
              <span className="truncate">{t("assistant.panel.selectedContext")}</span>
              <button
                type="button"
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                aria-label={t("assistant.panel.removeSelectedContext")}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  clearSelectedContext();
                }}
              >
                <X size={11} strokeWidth={2} />
              </button>
            </div>
          ) : (
            <>
              <span className="truncate">{t("assistant.panel.selectionHint")}</span>
              {readableVoiceHotkey && (
                <kbd className="ml-2 inline-flex rounded-md border border-border/40 bg-foreground/5 px-2 py-1 font-mono text-[11px] tracking-normal text-foreground/65 shadow-sm">
                  {readableVoiceHotkey}
                </kbd>
              )}
            </>
          )}
        </div>
      </header>

      <div className="relative mx-4 min-h-0 flex-1 overflow-hidden rounded-2xl border border-border/40 bg-surface-1 shadow-inner">
        <main
          data-panel-scroll-region
          className="agent-chat-scroll h-full overflow-y-auto px-5 py-4"
          aria-busy={thinking || isBusy}
        >
          <div
            data-panel-size-source
            className={`assistant-response-content ${
              showContentFlourish ? "assistant-response-content-updating" : ""
            }`}
          >
            {displayedResponse ? (
              <div
                ref={responseSelectionRootRef}
                style={{ animation: "agent-message-in 160ms ease-out both" }}
              >
                <StableAssistantMarkdown
                  content={displayedResponse}
                  className="text-[15px] leading-relaxed text-foreground selection:bg-agent-brand/35 selection:text-foreground [&_p]:text-[15px] [&_li]:text-[15px]"
                />
                {latestAssistantMessage?.isStreaming && (
                  <span
                    className="ml-0.5 inline-block h-4 w-0.5 align-middle bg-foreground/70"
                    style={{ animation: "agent-cursor-blink 1s ease-in-out infinite" }}
                  />
                )}
              </div>
            ) : null}
            {thinking && (
              <div role="status">
                <span className="sr-only">{t("agentMode.input.thinking")}</span>
              </div>
            )}
          </div>
        </main>

        {showContentFlourish && (
          <div
            className="assistant-content-area-shimmer pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-2xl"
            aria-hidden="true"
          />
        )}
        {isToolExecuting && (
          <div
            className="assistant-tool-invocation pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-6"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-tool-invocation={streaming.activeToolName}
          >
            <span className="sr-only">{streaming.toolStatus}</span>
            <div
              className="assistant-tool-invocation-status inline-flex max-w-full items-center gap-2.5 rounded-xl border border-border/60 bg-surface-raised/60 px-4 py-2.5 shadow-[var(--shadow-card)] backdrop-blur-md"
              aria-hidden="true"
            >
              <span className="assistant-tool-invocation-pulse relative flex size-2 shrink-0 rounded-full bg-agent-brand" />
              <span
                key={`${streaming.activeToolName}-${toolVerbIndex}`}
                className="assistant-tool-invocation-verb w-16 text-right text-sm text-muted-foreground"
              >
                {AGENT_TOOL_ACTIVITY_VERBS[toolVerbIndex]}
              </span>
              <span className="h-4 w-px shrink-0 bg-border/70" />
              <span className="truncate text-sm font-medium text-foreground">
                {formatAgentToolName(streaming.activeToolName)}
              </span>
            </div>
          </div>
        )}
      </div>

      <footer
        className={`flex h-16 shrink-0 items-center px-4 ${
          horizontalDirection === "left" ? "justify-start" : "justify-end"
        }`}
        data-assistant-footer-direction={horizontalDirection}
      >
        {footerPresentation.actionsMounted && (
          <div
            className={`assistant-response-actions flex items-center gap-2 ${
              horizontalDirection === "left" ? "flex-row-reverse" : ""
            }`}
            data-assistant-footer-phase={footerPhase}
            data-horizontal-direction={horizontalDirection}
            aria-hidden={footerPhase !== "actions"}
            style={
              {
                "--assistant-actions-retreat-duration": `${ASSISTANT_FOOTER_TRANSITION_TIMING.actionsRetreatMs}ms`,
                "--assistant-actions-entrance-duration": `${ASSISTANT_FOOTER_TRANSITION_TIMING.actionsEntranceMs}ms`,
              } as CSSProperties
            }
          >
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-full px-4"
              onClick={onClose}
              tabIndex={footerPhase === "actions" ? 0 : -1}
            >
              <X aria-hidden="true" />
              {t("common.close")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="rounded-full border-border/70 bg-surface-raised px-4 font-medium text-foreground shadow-sm hover:bg-surface-3 dark:border-white dark:bg-white dark:text-neutral-950 dark:hover:bg-white/90"
              onClick={() => void handleCopy()}
              aria-live="polite"
              tabIndex={footerPhase === "actions" ? 0 : -1}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? t("common.copied") : t("assistant.panel.copyToClipboard")}
              {!copied && (
                <kbd className="ml-1 rounded bg-foreground/10 px-1.5 py-0.5 font-mono text-[10px] font-medium dark:bg-black/10">
                  C
                </kbd>
              )}
            </Button>
          </div>
        )}
      </footer>
    </>
  );
}
