import {
  memo,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Copy,
  CopyRounded,
  Check,
  Search,
  FileText,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  GitFork,
} from "../icons";
import { cn } from "../lib/utils";
import { MarkdownRenderer } from "../ui/MarkdownRenderer";
import { TechnicalErrorDetails } from "../ui/TechnicalErrorDetails";
import { openProviderSettings } from "../../utils/describeProviderError";
import type { AssistantTurn, MessageError, ToolCallInfo } from "./types";
import { toolCallStepText, visibleToolCalls } from "./toolCallText";
import { extractNoteCards } from "./noteCards";
import { helpAnswerPlainText } from "./helpEvidenceText";
import { HelpEvidence } from "./GroundedHelpEvidence";
import { extractHelpEvidence } from "./helpEvidence";
import { toolIcons } from "./toolIcons";
import { ApprovalCard } from "./ApprovalCard";
import { InteractionCard, InteractionOutcomeRow } from "./InteractionCard";
import { ApiKeySavedRow } from "./interactions/ApiKeyCard";
import { approvalKey, useConnectorApprovalStore } from "../../stores/connectorApprovalStore";
import { useAgentInteractionStore } from "../../stores/agentInteractionStore";
import { SkillApprovalCard, SkillCardSummary } from "./SkillApprovalCard";
import { readSkillCardRecord } from "./skillCardRecord";
import { CodeBlockActions } from "./CodeBlockActions";
import { useSkillApprovalStore } from "../../stores/skillApprovalStore";

// Module-level, so the markdown keeps the same callback from render to render.
const copyCodeBlock = (code: string) => <CodeBlockActions code={code} />;

interface ChatMessageProps {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  isStreaming: boolean;
  toolCalls?: ToolCallInfo[];
  error?: MessageError;
  onOpenNote?: (noteId: number) => void;
  plain?: boolean;
  turn?: AssistantTurn;
  /** Saved messages only: a fork's history runs through a saved row. */
  dbId?: number;
  onFork?: (messageId: string) => void;
  /** Offered on a reply that stopped at the step limit. */
  onContinue?: () => void;
}

function ToolCallStep({ toolCall }: { toolCall: ToolCallInfo }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const Icon = toolIcons[toolCall.name] || Search;
  const isExecuting = toolCall.status === "executing";
  const isError = toolCall.status === "error";
  const isCompleted = toolCall.status === "completed" || toolCall.status === "stopped";
  const isClipboard = toolCall.name === "copy_to_clipboard" && toolCall.status === "completed";
  const stepText = toolCallStepText(toolCall, t);

  const resultLines = toolCall.result?.split("\n") ?? [];
  const hasDetail = resultLines.length > 1 && !isClipboard;

  return (
    <div
      className={cn(
        "relative rounded-md mb-1 overflow-hidden",
        "border-s-2 transition-colors duration-300",
        isExecuting && "border-s-primary/60",
        isCompleted && !isError && "border-s-muted-foreground/20",
        isClipboard && "border-s-emerald-500/50",
        isError && "border-s-destructive/50"
      )}
    >
      {isExecuting && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ animation: "tool-step-shimmer 2s ease-in-out infinite" }}
        />
      )}

      <div
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1.5",
          "bg-surface-1/60",
          hasDetail && !isExecuting && "cursor-pointer"
        )}
        onClick={hasDetail && !isExecuting ? () => setExpanded((v) => !v) : undefined}
      >
        <Icon
          size={12}
          className={cn(
            "shrink-0 transition-colors duration-300",
            isExecuting && "text-primary/70",
            isCompleted && !isError && !isClipboard && "text-muted-foreground/70",
            isClipboard && "text-emerald-500/70",
            isError && "text-destructive/60"
          )}
        />

        {isExecuting ? (
          <span className="text-[11px] text-muted-foreground/80">{stepText}</span>
        ) : isError ? (
          <div className="flex items-center gap-1">
            <CircleAlert size={10} className="text-destructive/60 shrink-0" />
            <span className="text-[11px] text-destructive/70">{stepText}</span>
          </div>
        ) : isClipboard ? (
          <div className="flex items-center gap-1">
            <span className="text-[11px] text-emerald-600 dark:text-emerald-400/80">
              {stepText}
            </span>
            <Check
              size={10}
              className="text-emerald-500 shrink-0"
              style={{ animation: "tool-check-pop 300ms ease-out both" }}
            />
          </div>
        ) : (
          <span className="text-[11px] text-muted-foreground/70">{stepText}</span>
        )}

        {hasDetail && !isExecuting && (
          <ChevronDown
            size={10}
            className={cn(
              "ms-auto text-muted-foreground/70 shrink-0 transition-transform duration-200",
              expanded && "rotate-180"
            )}
          />
        )}
      </div>

      {hasDetail && !isExecuting && (
        <div
          className="overflow-hidden transition-all duration-200"
          style={{ maxHeight: expanded ? `${resultLines.length * 16 + 12}px` : "0px" }}
        >
          <pre
            dir="ltr"
            className="text-[10px] text-muted-foreground/70 px-2.5 pb-1.5 whitespace-pre-wrap leading-tight"
          >
            {toolCall.result}
          </pre>
        </div>
      )}
    </div>
  );
}

interface ToolCallProps {
  messageId: string;
  toolCall: ToolCallInfo;
}

// The card a call is waiting on the user with: an approval, or a question,
// connection or other interaction. Subscribes to its own entries only, so
// editing one card doesn't re-render every message in the thread.
function useToolCallCard(
  { messageId, toolCall }: ToolCallProps,
  /** Where steps don't show: the card's last height, which its outcome row eases down from. */
  cardHeightRef?: MutableRefObject<number>
): ReactElement | null {
  const key = approvalKey(messageId, toolCall.id);
  const approval = useConnectorApprovalStore((state) => state.entries[key]);
  const interaction = useAgentInteractionStore((state) => state.entries[key]);
  const skillApproval = useSkillApprovalStore((state) => state.entries[key]);
  const receiptRef = useRef<HTMLDivElement>(null);
  const ownedFocusRef = useRef(false);
  useLayoutEffect(() => {
    if (
      interaction?.state === "settled" &&
      ownedFocusRef.current &&
      document.hasFocus() &&
      (!document.activeElement || document.activeElement === document.body)
    ) {
      receiptRef.current?.focus({ preventScroll: true });
    }
  }, [interaction?.state]);
  if (!interaction) {
    if (approval) return <ApprovalCard entry={approval} />;
    if (skillApproval) return <SkillApprovalCard entry={skillApproval} />;
    const skillRecord = readSkillCardRecord(toolCall);
    return skillRecord ? <SkillCardSummary record={skillRecord} /> : null;
  }
  let card: ReactElement;
  // An open question goes first: after Retry, the Slack picker waits under the
  // key of the answer card it settled.
  if (interaction.state !== "settled") {
    card = <InteractionCard entry={interaction} heightRef={cardHeightRef} />;
  } else if (approval) {
    card = <ApprovalCard entry={approval} />;
  }
  // A saved key stays visible as saved; every other settled card gives way to
  // its step, or where steps don't show, to its outcome row.
  else if (interaction.payload.kind === "apiKey" && interaction.result?.status === "saved") {
    card = <ApiKeySavedRow payload={interaction.payload} />;
  } else {
    card = cardHeightRef ? (
      <InteractionOutcomeRow entry={interaction} fromHeight={cardHeightRef.current} />
    ) : (
      <ToolCallStep toolCall={toolCall} />
    );
  }
  return (
    <div
      ref={receiptRef}
      tabIndex={-1}
      className="outline-none"
      onFocusCapture={() => {
        ownedFocusRef.current = true;
      }}
      onBlurCapture={(event) => {
        ownedFocusRef.current = event.currentTarget.contains(event.relatedTarget);
      }}
    >
      {card}
    </div>
  );
}

/** The agent window's card for a call; its steps show in the progress row instead. */
export function ToolCallCard(props: ToolCallProps): ReactElement | null {
  const cardHeightRef = useRef(0);
  return useToolCallCard(props, cardHeightRef);
}

function ToolCallItem(props: ToolCallProps) {
  return useToolCallCard(props) ?? <ToolCallStep toolCall={props.toolCall} />;
}

// How the turn ended, when that needs saying, and the model's reasoning.
export function TurnNotes({
  turn,
  failedHere,
  onContinue,
  showReasoning = true,
}: {
  turn: AssistantTurn;
  /** The failure is already on screen (this session); a saved one shows only this note. */
  failedHere: boolean;
  onContinue?: () => void;
  /** Off where the reasoning has a place of its own (the agent window's progress row). */
  showReasoning?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {showReasoning && turn.reasoning && (
        <details className="mt-1.5 text-[11px] text-muted-foreground/80">
          <summary className="cursor-pointer select-none">{t("agentMode.turn.reasoning")}</summary>
          <p className="mt-1 whitespace-pre-wrap" dir="auto">
            {turn.reasoning}
          </p>
        </details>
      )}
      {turn.status === "stopped" && (
        <p className="mt-1.5 text-[11px] text-muted-foreground/80">{t("agentMode.turn.stopped")}</p>
      )}
      {turn.status === "error" && !failedHere && (
        <p className="mt-1.5 text-[11px] text-destructive/80">{t("agentMode.turn.failed")}</p>
      )}
      {turn.unbackedClaim && (
        <p className="mt-1.5 text-[11px] text-destructive/80">
          {t("agentMode.turn.unbackedClaim")}
        </p>
      )}
      {turn.status === "step_limit" && (
        <p className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground/80">
          {t("agentMode.turn.stepLimit")}
          {onContinue && (
            <button
              type="button"
              onClick={onContinue}
              className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-sm"
            >
              {t("agentMode.turn.continue")}
            </button>
          )}
        </p>
      )}
    </>
  );
}

function NoteCard({
  noteId,
  title,
  onOpenNote,
}: {
  noteId: number;
  title: string;
  onOpenNote?: (noteId: number) => void;
}) {
  const { t } = useTranslation();

  return (
    <button
      onClick={() =>
        onOpenNote ? onOpenNote(noteId) : window.electronAPI?.agentOpenNote?.(noteId)
      }
      className={cn(
        "flex items-center gap-2 w-full mt-2 px-2.5 py-2 rounded-md",
        "bg-primary/6 border border-primary/12",
        "hover:bg-primary/10 hover:border-primary/20",
        "active:scale-[0.99]",
        "transition-all duration-150",
        "text-start group/note"
      )}
    >
      <div className={cn("shrink-0 p-1 rounded", "bg-primary/10")}>
        <FileText size={12} className="text-primary/70" />
      </div>
      <div className="min-w-0 flex-1">
        <p dir="auto" className="text-[12px] font-medium text-foreground truncate">
          {title}
        </p>
        <p className="text-[10px] text-muted-foreground/70">{t("agentMode.tools.openNote")}</p>
      </div>
      <ChevronRight
        size={12}
        className="text-muted-foreground/70 group-hover/note:text-primary/50 shrink-0 transition-colors duration-150 rtl:rotate-180"
      />
    </button>
  );
}

// Memoized: hosts re-render on every keystroke in their composer (or, for note chat, in
// the note), and only the streaming reply's props change between those renders.
export const ChatMessage = memo(function ChatMessage({
  messageId,
  role,
  content,
  isStreaming,
  toolCalls,
  error,
  onOpenNote,
  plain = false,
  turn,
  dbId,
  onFork,
  onContinue,
}: ChatMessageProps) {
  const { t, i18n } = useTranslation();
  const [copied, setCopied] = useState(false);

  const helpEvidence = role === "assistant" ? extractHelpEvidence(toolCalls) : null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(
        helpAnswerPlainText(content, helpEvidence, t, i18n?.resolvedLanguage)
      );
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
          data-chat-bubble
          className={cn(
            "max-w-[80%] text-[13px] leading-relaxed",
            plain
              ? "rounded-2xl rounded-ee-md bg-foreground/[0.07] px-3.5 py-2 text-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.5)] dark:bg-white/[0.09] dark:shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]"
              : "rounded-lg rounded-ee-sm bg-primary/90 px-3 py-2 text-primary-foreground"
          )}
        >
          <span dir="auto" className="whitespace-pre-wrap">
            {content}
          </span>
        </div>
      </div>
    );
  }

  const steps = visibleToolCalls(toolCalls);
  const hasToolCalls = steps.length > 0;
  const hasContent = content.length > 0;
  const noteCards = extractNoteCards(toolCalls, t("notes.list.untitledNote"));

  return (
    <div
      className="group/msg flex justify-start"
      style={{ animation: "agent-message-in 200ms ease-out both" }}
    >
      <div
        data-chat-bubble
        className={cn(
          "text-[13px] leading-relaxed text-foreground",
          plain
            ? "max-w-full px-1 py-1"
            : "max-w-[85%] rounded-lg rounded-es-sm border border-border/70 bg-surface-1 px-3 py-2"
        )}
      >
        {hasToolCalls && (
          <div
            className={cn(
              (hasContent || noteCards.length > 0) && "mb-2 pb-1.5 border-b border-border/70"
            )}
          >
            {steps.map((tc) => (
              <ToolCallItem key={tc.id} messageId={messageId} toolCall={tc} />
            ))}
          </div>
        )}

        {hasContent && (
          <MarkdownRenderer
            content={content}
            className="text-[13px] leading-relaxed [&_p]:text-[13px] [&_li]:text-[13px]"
            codeBlockActions={copyCodeBlock}
          />
        )}

        {helpEvidence && <HelpEvidence evidence={helpEvidence} />}

        {isStreaming && hasContent && (
          <span
            className="inline-block w-[2px] h-[14px] bg-foreground/70 align-middle ms-0.5"
            style={{ animation: "agent-cursor-blink 1s ease-in-out infinite" }}
          />
        )}

        {isStreaming && !hasContent && !hasToolCalls && (
          <span className="text-[13px] font-medium select-none thinking-shimmer-text">
            {t("agentMode.input.thinking")}...
          </span>
        )}

        {error?.settingsTarget && (
          <button
            type="button"
            onClick={() => openProviderSettings(error.settingsTarget!)}
            className="mt-1.5 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-sm"
          >
            {t("providerErrors.openSettings")}
          </button>
        )}
        {error?.technicalDetails && <TechnicalErrorDetails details={error.technicalDetails} />}

        {turn && !isStreaming && (
          <TurnNotes turn={turn} failedHere={!!error} onContinue={onContinue} />
        )}

        {noteCards.length > 0 && !isStreaming && (
          <div>
            {noteCards.map((card) => (
              <NoteCard
                key={card.noteId}
                noteId={card.noteId}
                title={card.title}
                onOpenNote={onOpenNote}
              />
            ))}
          </div>
        )}

        {hasContent && !isStreaming && (
          <div className={cn("flex justify-start mt-1.5", !plain && "-mb-0.5")}>
            <button
              type="button"
              onClick={handleCopy}
              aria-label={t(copied ? "common.copied" : "common.copy")}
              title={t(copied ? "common.copied" : "common.copy")}
              className={cn(
                plain
                  ? // Always there in the note chat, not only on hover.
                    "flex size-7 items-center justify-center rounded-full text-foreground/45 hover:bg-foreground/[0.07] hover:text-foreground dark:hover:bg-white/[0.08] transition-colors duration-150"
                  : "p-1 rounded-sm text-muted-foreground/70 hover:text-foreground hover:bg-foreground/8 opacity-0 group-hover/msg:opacity-100 transition-all duration-150",
                "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
              )}
            >
              {copied ? (
                <Check size={plain ? 15 : 12} className="text-emerald-500" />
              ) : plain ? (
                <CopyRounded size={15} />
              ) : (
                <Copy size={12} />
              )}
            </button>
            {onFork && dbId != null && (
              <button
                type="button"
                onClick={() => onFork(messageId)}
                aria-label={t("chat.fork")}
                title={t("chat.fork")}
                className="p-1 rounded-sm text-muted-foreground/70 hover:text-foreground hover:bg-foreground/8 opacity-0 group-hover/msg:opacity-100 transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/30 focus-visible:opacity-100"
              >
                <GitFork size={12} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
