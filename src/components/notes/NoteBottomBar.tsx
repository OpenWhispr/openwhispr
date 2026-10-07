import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatInput } from "../chat/ChatInput";
import type { AgentState } from "../chat/types";
import type { SlashCommand } from "../chat/slashCommands";
import { cn } from "../lib/utils";
import { hasLayerAbove } from "../ui/useDismissGuard";
import { observeFloatingChatSize } from "./floatingChatLayout";

const RECORDING_SURFACE = "bg-surface-2/95 shadow-(--shadow-glass)";
// One curve for everything that moves as the chat opens, so it unfolds as one piece:
// a soft spring that settles just past its mark.
const UNFOLD =
  "duration-[480ms] ease-[cubic-bezier(0.25,1.15,0.4,1)] motion-reduce:transition-none";
const DRAG_START_THRESHOLD_PX = 3;

interface NoteBottomBarProps {
  isRecording: boolean;
  draftText: string;
  onDraftChange: (text: string) => void;
  onAskSubmit: (text: string) => void;
  onInputFocus?: () => void;
  onInputEscape?: () => void;
  /**
   * A click outside the open chat, other than one dismissing a menu or dialog over the page.
   * Keep it stable: the panel's observers re-attach whenever it changes.
   */
  onClickOutside?: () => void;
  /** Sits in the collapsed composer; the chips take over once the chat opens. */
  actionPicker?: React.ReactNode;
  actionChips?: React.ReactNode;
  slashCommands?: SlashCommand[];
  callout?: React.ReactNode;
  footnote?: React.ReactNode;
  hideInput?: boolean;
  chatOpen?: boolean;
  chatContent?: React.ReactNode;
  agentState?: AgentState;
  onCancel?: () => void;
  floatingPanelRef?: (panel: HTMLDivElement, container: HTMLElement) => void | (() => void);
}

export default function NoteBottomBar({
  isRecording,
  draftText,
  onDraftChange,
  onAskSubmit,
  onInputFocus,
  onInputEscape,
  onClickOutside,
  actionPicker,
  actionChips,
  slashCommands,
  callout,
  footnote,
  hideInput = false,
  chatOpen = false,
  chatContent,
  agentState = "idle",
  onCancel,
  floatingPanelRef,
}: NoteBottomBarProps) {
  const { t } = useTranslation();
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);

  const attachPanel = useCallback(
    (panel: HTMLDivElement | null) => {
      if (!panel) return;
      if (!chatOpen) {
        panel.style.height = "48px";
        return;
      }

      // Panel → composer slot (with the card) → bar → the note view the bar floats over.
      const slot = panel.parentElement;
      const container = slot?.parentElement?.parentElement;
      if (!slot || !container) return;

      const stopSizing = observeFloatingChatSize({
        panel,
        container,
      });
      const stopLayout = floatingPanelRef?.(panel, container);
      // Decided on press, while a menu it dismisses is still open, but acted on at click:
      // closing drops the note's bottom inset, which would move the note under the press.
      let outsidePress: { x: number; y: number } | null = null;
      const handlePointerDown = (event: PointerEvent) => {
        outsidePress =
          !slot.contains(event.target as Node) && !hasLayerAbove(panel, document)
            ? { x: event.clientX, y: event.clientY }
            : null;
      };
      // A keyboard click (detail 0) has no press of its own, so a stale one mustn't count for it,
      // and a drag (selecting text) ends in a click too but isn't one.
      const handleClick = (event: MouseEvent) => {
        if (
          outsidePress &&
          event.detail > 0 &&
          Math.abs(event.clientX - outsidePress.x) < DRAG_START_THRESHOLD_PX &&
          Math.abs(event.clientY - outsidePress.y) < DRAG_START_THRESHOLD_PX
        ) {
          onClickOutside?.();
        }
        outsidePress = null;
      };
      document.addEventListener("pointerdown", handlePointerDown, true);
      document.addEventListener("click", handleClick, true);

      return () => {
        stopSizing();
        if (typeof stopLayout === "function") stopLayout();
        document.removeEventListener("pointerdown", handlePointerDown, true);
        document.removeEventListener("click", handleClick, true);
      };
    },
    [chatOpen, floatingPanelRef, onClickOutside]
  );

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 z-20 px-5 pt-6",
        footnote ? "pb-1.5" : "pb-7"
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background from-45% to-transparent transition-opacity duration-200",
          chatOpen && "opacity-0"
        )}
      />
      {callout && !chatOpen && !hideInput && (
        <div className="pointer-events-auto relative mb-3 flex justify-center">{callout}</div>
      )}
      {/* The composer's slot: the panel always fills it, so the composer never moves. */}
      <div
        className={cn(
          "group/chat relative mx-auto w-full min-w-0 transition-[max-width]",
          UNFOLD,
          hideInput ? "max-w-0" : "max-w-[600px]"
        )}
      >
        {/* The card hugs the composer as the bar, then unfolds around it as the chat opens. */}
        <div
          aria-hidden="true"
          // Pressing the card's margin keeps focus (and the chat) on the composer.
          onMouseDown={(event) => event.preventDefault()}
          className={cn(
            "absolute border transition-[inset,border-radius,box-shadow,background-color,border-color,opacity]",
            UNFOLD,
            chatOpen
              ? "-inset-2 rounded-[32px] bg-background shadow-(--shadow-chat-card)"
              : cn(
                  "inset-0 rounded-3xl",
                  isRecording ? RECORDING_SURFACE : "bg-background shadow-(--shadow-glass)",
                  "group-hover/chat:border-black/15 dark:group-hover/chat:border-white/22"
                ),
            "border-black/[0.08] dark:border-white/12",
            "group-focus-within/chat:border-black/15 group-focus-within/chat:ring-[3px] group-focus-within/chat:ring-primary/8 dark:group-focus-within/chat:border-white/22",
            hideInput ? "pointer-events-none opacity-0" : "pointer-events-auto"
          )}
        />
        <div
          ref={attachPanel}
          data-note-chat-panel
          aria-hidden={hideInput}
          inert={hideInput}
          className={cn(
            // Bottom-anchored: while it grows, what doesn't fit yet overflows the top, not the composer.
            "pointer-events-auto relative flex min-w-0 flex-col justify-end rounded-3xl transition-[height,opacity]",
            UNFOLD,
            chatOpen || hideInput ? "overflow-hidden" : "overflow-visible",
            hideInput && "opacity-0 pointer-events-none"
          )}
        >
          <div
            aria-hidden={!chatOpen}
            inert={!chatOpen}
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-[opacity,transform] motion-reduce:transition-none",
              // In just behind the card as it opens; out at once as it closes.
              chatOpen
                ? "translate-y-0 opacity-100 duration-300 delay-150 ease-out"
                : "translate-y-2 opacity-0 duration-150",
              slashMenuOpen && "hidden"
            )}
          >
            {chatContent}
          </div>
          {actionChips && chatOpen && !slashMenuOpen && (
            <div className="shrink-0 px-1.5 pt-2 pb-1">{actionChips}</div>
          )}
          {!hideInput && (
            <ChatInput
              className="w-full min-w-0"
              variant="note"
              outlined={chatOpen}
              agentState={agentState}
              partialTranscript=""
              draftText={draftText}
              onDraftChange={onDraftChange}
              onTextSubmit={onAskSubmit}
              onCancel={onCancel}
              onFocus={onInputFocus}
              onEscape={onInputEscape}
              focusOnIdle={chatOpen}
              voiceDraft={chatOpen}
              placeholder={t("embeddedChat.askPlaceholder")}
              trailingContent={chatOpen ? undefined : actionPicker}
              slashCommands={slashCommands}
              onSlashMenuOpenChange={setSlashMenuOpen}
            />
          )}
        </div>
      </div>
      {footnote && (
        <div
          className={cn(
            "relative mt-1.5 flex h-4 select-none items-center justify-center gap-1 text-[10px] text-muted-foreground/70 transition-opacity duration-200",
            // The open card reaches over it.
            chatOpen && "opacity-0"
          )}
        >
          {footnote}
        </div>
      )}
    </div>
  );
}
