import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChatInput } from "../chat/ChatInput";
import type { SlashCommand } from "../chat/slashCommands";
import { cn } from "../lib/utils";
import { hasLayerAbove } from "../ui/useDismissGuard";
import { observeFloatingChatMaxHeight } from "./floatingChatLayout";

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
  floatingPanelRef,
}: NoteBottomBarProps) {
  const { t } = useTranslation();
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);

  const attachPanel = useCallback(
    (panel: HTMLDivElement | null) => {
      if (!panel) return;
      if (!chatOpen) {
        panel.style.height = "48px";
        panel.style.maxHeight = "";
        return;
      }
      // Open, it fits the chips and the composer (or the / menu), within a cap.
      panel.style.height = "auto";

      // Panel → composer slot (with the card) → bar → the note view the bar floats over.
      const slot = panel.parentElement;
      const container = slot?.parentElement?.parentElement;
      if (!slot || !container) return;

      const stopSizing = observeFloatingChatMaxHeight({
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
          // From anywhere in the open chat, not just the composer. An Esc that closes a menu
          // (Radix prevents its default) closes only the menu, and one that closes the chat
          // stops here, so the note doesn't also clear its transcript selection.
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !chatOpen || event.defaultPrevented) return;
            event.stopPropagation();
            onInputEscape?.();
          }}
          className={cn(
            // Bottom-anchored: while it grows, what doesn't fit yet overflows the top, not the composer.
            // Its height animates between the bar's 48px and auto.
            "pointer-events-auto relative flex min-w-0 flex-col justify-end rounded-3xl transition-[height,opacity] [interpolate-size:allow-keywords]",
            UNFOLD,
            // Open, it clips only while it unfolds, so a chip's hover card can show above it.
            hideInput
              ? "overflow-hidden"
              : chatOpen
                ? "animate-[clip-while-unfolding_480ms] motion-reduce:animate-none"
                : "overflow-visible",
            hideInput && "opacity-0 pointer-events-none"
          )}
        >
          {actionChips && chatOpen && !slashMenuOpen && (
            // Centered between the card's top edge and the composer.
            <div className="shrink-0 px-1.5 pt-0.5 pb-2.5">{actionChips}</div>
          )}
          {!hideInput && (
            <ChatInput
              className="w-full min-w-0"
              variant="note"
              outlined={chatOpen}
              agentState="idle"
              partialTranscript=""
              draftText={draftText}
              onDraftChange={onDraftChange}
              onTextSubmit={onAskSubmit}
              onFocus={onInputFocus}
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
