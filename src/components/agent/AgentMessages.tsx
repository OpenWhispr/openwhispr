import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  CopyRounded,
  CornerDownLeft,
  GitFork,
  RefreshCw,
  TextSelect,
  Volume,
} from "../icons";
import { cn } from "../lib/utils";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { TechnicalErrorDetails } from "../ui/TechnicalErrorDetails";
import { HelpEvidence } from "../chat/GroundedHelpEvidence";
import { extractHelpEvidence } from "../chat/helpEvidence";
import { helpAnswerPlainText } from "../chat/helpEvidenceText";
import { ToolCallCard, TurnNotes } from "../chat/ChatMessage";
import { visibleToolCalls } from "../chat/toolCallText";
import type { Message } from "../chat/types";
import type { ForkOrigin } from "../chat/useChatPersistence";
import { useStickToBottom } from "../../hooks/useStickToBottom";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { openProviderSettings } from "../../utils/describeProviderError";
import { getSelectionInside } from "../../utils/assistantSelection";
import { AgentProgressRow } from "./AgentProgressRow";
import { placeSelectionToolbar, type ToolbarAnchor } from "./selectionToolbarPlacement";
import { ForkOriginChip, SelectedContextBlock } from "./AgentContext";

export interface ReadAloud {
  available: boolean;
  speakingId: string | null;
  toggle: (id: string, markdown: string) => void;
}

interface AssistantMessageProps {
  message: Message;
  latest: boolean;
  /** A reply is running, so nothing new may start from this one. */
  busy: boolean;
  readAloud: ReadAloud;
  onRegenerate: (message: Message) => void;
  onFork: (messageId: string) => void;
  onContinue: () => void;
}

const ACTION_BUTTON =
  "flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 disabled:opacity-40 disabled:hover:bg-transparent";

function ResponseActions({
  message,
  latest,
  busy,
  readAloud,
  onRegenerate,
  onFork,
}: Omit<AssistantMessageProps, "onContinue">) {
  const { t, i18n } = useTranslation();
  const helpEvidence = extractHelpEvidence(message.toolCalls);
  const { copied, copyText, confirmCopied } = useCopyFeedback(message.content);
  const speaking = readAloud.speakingId === message.id;

  const copy = async () => {
    const text = helpAnswerPlainText(message.content, helpEvidence, t, i18n?.resolvedLanguage);
    if (await copyText(text.trim())) confirmCopied(message.content);
  };

  return (
    <div className="-ms-2 flex items-center gap-0.5">
      {latest && (
        <button
          type="button"
          onClick={() => onRegenerate(message)}
          disabled={busy}
          aria-label={t("agentWindow.actions.regenerate")}
          title={t("agentWindow.actions.regenerate")}
          className={ACTION_BUTTON}
        >
          <RefreshCw size={15} />
        </button>
      )}
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={t(copied ? "common.copied" : "common.copy")}
        title={t(copied ? "common.copied" : "common.copy")}
        className={cn(ACTION_BUTTON, copied && "w-auto gap-1 px-2 text-foreground")}
      >
        {copied ? <Check size={15} className="text-success" /> : <CopyRounded size={15} />}
        {copied && (
          <span className="text-xs" aria-live="polite">
            {t("common.copied")}
          </span>
        )}
      </button>
      {message.dbId != null && (
        <button
          type="button"
          onClick={() => onFork(message.id)}
          disabled={busy}
          aria-label={t("chat.fork")}
          title={t("chat.fork")}
          className={ACTION_BUTTON}
        >
          <GitFork size={15} />
        </button>
      )}
      {readAloud.available && (
        <button
          type="button"
          onClick={() => readAloud.toggle(message.id, message.content)}
          aria-pressed={speaking}
          aria-label={t(
            speaking ? "agentWindow.actions.stopReading" : "agentWindow.actions.readAloud"
          )}
          title={t(speaking ? "agentWindow.actions.stopReading" : "agentWindow.actions.readAloud")}
          className={cn(ACTION_BUTTON, speaking && "bg-primary/15 text-primary")}
        >
          <Volume size={15} />
        </button>
      )}
      {latest && (
        <span className="ms-auto flex items-center gap-1.5 text-[13px] text-muted-foreground/80">
          <TextSelect size={14} />
          {t("agentWindow.selectionHint")}
        </span>
      )}
    </div>
  );
}

// Memoized: only the streaming reply's props change while it streams.
const AssistantMessage = memo(function AssistantMessage(props: AssistantMessageProps) {
  const { t } = useTranslation();
  const { message, onContinue } = props;
  const helpEvidence = extractHelpEvidence(message.toolCalls);
  const steps = visibleToolCalls(message.toolCalls);
  return (
    <div data-agent-message={message.id} className="flex flex-col gap-2">
      <AgentProgressRow message={message} />
      {steps.map((step) => (
        <ToolCallCard key={step.id} messageId={message.id} toolCall={step} />
      ))}
      {message.content && (
        <div data-agent-answer>
          <MarkdownRenderer
            content={message.content}
            className="text-[15px] leading-snug text-foreground selection:bg-primary selection:text-primary-foreground [&_li]:text-[15px] [&_ol]:space-y-0 [&_p]:text-[15px] [&_ul]:space-y-0"
          />
        </div>
      )}
      {helpEvidence && <HelpEvidence evidence={helpEvidence} />}
      {message.error?.settingsTarget && (
        <button
          type="button"
          onClick={() => openProviderSettings(message.error!.settingsTarget!)}
          className="self-start rounded-sm text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {t("providerErrors.openSettings")}
        </button>
      )}
      {message.error?.technicalDetails && (
        <TechnicalErrorDetails details={message.error.technicalDetails} />
      )}
      {message.turn && !message.isStreaming && (
        <div className="text-end [&_p]:text-[13px]">
          <TurnNotes
            turn={message.turn}
            failedHere={!!message.error}
            onContinue={props.latest ? onContinue : undefined}
            showReasoning={false}
          />
        </div>
      )}
      {message.content && !message.isStreaming && <ResponseActions {...props} />}
    </div>
  );
});

function UserMessage({ message }: { message: Message }) {
  return (
    <div className="flex flex-col items-end gap-2">
      {message.selectedContext && (
        <SelectedContextBlock
          text={message.selectedContext}
          source={message.selectedContextSource}
          className="self-stretch"
        />
      )}
      <div
        dir="auto"
        className="max-w-[85%] whitespace-pre-wrap rounded-[18px] bg-surface-3 px-3 py-2 dark:bg-surface-2 text-[14px] leading-5 text-foreground"
      >
        {message.content}
      </div>
    </div>
  );
}

interface SelectionTarget extends ToolbarAnchor {
  messageId: string;
  text: string;
}

// Text selected inside one answer, and where its toolbar goes.
function readSelection(scroller: HTMLElement | null): SelectionTarget | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start =
    range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
  const answer = start?.closest("[data-agent-answer]");
  const message = answer?.closest("[data-agent-message]");
  const text = getSelectionInside(answer as HTMLElement | null);
  if (!answer || !message || !text || !scroller) return null;
  return {
    messageId: message.getAttribute("data-agent-message") ?? "",
    text,
    rect: range.getBoundingClientRect(),
    bounds: scroller.getBoundingClientRect(),
  };
}

function SelectionToolbar({
  target,
  busy,
  onFollowUp,
  onForkFrom,
}: {
  target: SelectionTarget;
  busy: boolean;
  onFollowUp: () => void;
  /** Absent for a reply that isn't saved yet: there is nothing to fork from. */
  onForkFrom?: () => void;
}) {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  // Measured before paint, so it never shows where it doesn't fit, and again
  // when Fork from here appears (the reply was saved) and widens it.
  const forkable = Boolean(onForkFrom);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (toolbar) setPosition(placeSelectionToolbar(target, toolbar.getBoundingClientRect()));
  }, [target, forkable]);
  const item =
    "flex h-full items-center gap-2 px-3.5 text-[15px] text-foreground transition-colors hover:bg-foreground/10 focus:outline-none focus-visible:bg-foreground/10 disabled:opacity-40";
  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={t("agentWindow.selectionToolbar")}
      // Keeps the selection while a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
      className="fixed z-30 flex h-10 items-center overflow-hidden rounded-full border border-border bg-surface-1 shadow-[var(--shadow-card)]"
      style={position ?? { top: 0, left: 0, visibility: "hidden" }}
    >
      <button type="button" onClick={onFollowUp} className={item}>
        <CornerDownLeft size={15} className="rtl:scale-x-[-1]" />
        {t("agentWindow.followUp")}
      </button>
      {onForkFrom && (
        <>
          <span className="h-4 w-px bg-border" aria-hidden="true" />
          <button type="button" onClick={onForkFrom} disabled={busy} className={item}>
            <GitFork size={15} />
            {t("agentWindow.forkFromHere")}
          </button>
        </>
      )}
    </div>
  );
}

interface AgentMessageListProps {
  messages: Message[];
  forkOrigin: ForkOrigin | null;
  onOpenParent: (conversationId: number) => void;
  busy: boolean;
  readAloud: ReadAloud;
  onRegenerate: (message: Message) => void;
  onFork: (messageId: string, selectedText?: string) => void;
  onFollowUp: (selection: { messageId: string; text: string }) => void;
  onContinue: () => void;
  emptyState: ReactNode;
}

/** The chat, oldest first, scrolling inside the modal and following a reply while at the bottom. */
export function AgentMessageList({
  messages,
  forkOrigin,
  onOpenParent,
  busy,
  readAloud,
  onRegenerate,
  onFork,
  onFollowUp,
  onContinue,
  emptyState,
}: AgentMessageListProps) {
  const { scrollRef, handleScroll, handleWheel } = useStickToBottom<HTMLDivElement>(messages);
  // The list's height as of its last resize: a scroll event that sees another
  // height was queued before the resize (the bottom pin), not the reader's.
  const viewportHeightRef = useRef(0);
  const [selection, setSelection] = useState<SelectionTarget | null>(null);
  const visible = messages.filter((message) => message.role !== "tool");
  const lastId = visible.at(-1)?.id;
  const selectionSaved =
    selection != null && messages.some((m) => m.id === selection.messageId && m.dbId != null);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const measure = () => {
      viewportHeightRef.current = node.clientHeight;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollRef]);

  useEffect(() => {
    const update = () => setSelection(readSelection(scrollRef.current));
    const clearIfCollapsed = () => {
      if (window.getSelection()?.isCollapsed) setSelection(null);
    };
    document.addEventListener("mouseup", update);
    document.addEventListener("keyup", update);
    document.addEventListener("selectionchange", clearIfCollapsed);
    return () => {
      document.removeEventListener("mouseup", update);
      document.removeEventListener("keyup", update);
      document.removeEventListener("selectionchange", clearIfCollapsed);
    };
  }, [scrollRef]);

  const finishSelection = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, []);

  return (
    <div
      ref={scrollRef}
      onScroll={(event) => {
        // The scroll that pins the bottom arrives a frame late; when the list
        // shrank meanwhile (the selected context opening above the composer)
        // it would read as the reader leaving the bottom.
        if (event.currentTarget.clientHeight === viewportHeightRef.current) handleScroll();
        setSelection(null);
      }}
      onWheel={handleWheel}
      className="agent-chat-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-3"
    >
      {/* One child, so following the bottom sees everything the chat grows by. */}
      <div className="flex min-h-full flex-col">
        {/* A fork shows its own turns under the chip back to the chat it came from. */}
        {forkOrigin?.parentTitle && (
          <div className="flex justify-end pt-1 pb-4">
            <ForkOriginChip
              title={forkOrigin.parentTitle}
              onOpen={() => onOpenParent(forkOrigin.parentConversationId)}
            />
          </div>
        )}
        {visible.length === 0 ? (
          emptyState
        ) : (
          <div className="flex flex-col gap-4">
            {visible.map((message) =>
              message.role === "user" ? (
                <UserMessage key={message.id} message={message} />
              ) : (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  latest={message.id === lastId}
                  busy={busy}
                  readAloud={readAloud}
                  onRegenerate={onRegenerate}
                  onFork={onFork}
                  onContinue={onContinue}
                />
              )
            )}
          </div>
        )}
      </div>
      {selection && (
        <SelectionToolbar
          target={selection}
          busy={busy}
          onFollowUp={() => {
            onFollowUp(selection);
            finishSelection();
          }}
          onForkFrom={
            selectionSaved
              ? () => {
                  onFork(selection.messageId, selection.text);
                  finishSelection();
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
