import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ChatInput } from "../chat/ChatInput";
import type { AgentState } from "../chat/types";
import { cn } from "../lib/utils";
import { FLOATING_CHAT_MAX_HEIGHT_CSS, observeFloatingChatSize } from "./floatingChatLayout";

const RECORDING_SURFACE = "bg-surface-2/95 shadow-(--shadow-glass)";

interface NoteBottomBarProps {
  isRecording: boolean;
  draftText: string;
  onDraftChange: (text: string) => void;
  onAskSubmit: (text: string) => void;
  onInputFocus?: () => void;
  onInputEscape?: () => void;
  askDisabled?: boolean;
  actionPicker?: React.ReactNode;
  callout?: React.ReactNode;
  hideInput?: boolean;
  chatOpen?: boolean;
  chatContent?: React.ReactNode;
  agentState?: AgentState;
  onCancel?: () => void;
  floatingPanelRef?: (panel: HTMLDivElement | null) => void | (() => void);
}

export default function NoteBottomBar({
  isRecording,
  draftText,
  onDraftChange,
  onAskSubmit,
  onInputFocus,
  onInputEscape,
  askDisabled,
  actionPicker,
  callout,
  hideInput = false,
  chatOpen = false,
  chatContent,
  agentState = "idle",
  onCancel,
  floatingPanelRef,
}: NoteBottomBarProps) {
  const { t } = useTranslation();

  const attachPanel = useCallback(
    (panel: HTMLDivElement | null) => {
      if (!panel) return;
      if (!chatOpen) {
        panel.style.height = "48px";
        return;
      }

      const container = panel.parentElement?.parentElement;
      if (!container) return;

      const stopSizing = observeFloatingChatSize({
        panel,
        container,
      });
      const stopLayout = floatingPanelRef?.(panel);

      return () => {
        stopSizing();
        if (typeof stopLayout === "function") stopLayout();
      };
    },
    [chatOpen, floatingPanelRef]
  );

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 px-5 pb-7 pt-6">
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
      <div
        ref={attachPanel}
        data-note-chat-panel
        aria-hidden={hideInput}
        inert={hideInput}
        style={{ maxHeight: FLOATING_CHAT_MAX_HEIGHT_CSS }}
        className={cn(
          "pointer-events-auto relative mx-auto flex w-full min-w-0 max-w-[600px] flex-col rounded-3xl border",
          chatOpen || hideInput ? "overflow-hidden" : "overflow-visible",
          "transition-[height,box-shadow,max-width,opacity] duration-300 [transition-timing-function:cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
          isRecording && !chatOpen ? RECORDING_SURFACE : "bg-background shadow-sm",
          chatOpen
            ? "border-black/10 shadow-elevated dark:border-white/14"
            : "border-black/10 dark:border-white/14",
          "focus-within:border-black/15 focus-within:ring-[3px] focus-within:ring-primary/8 dark:focus-within:border-white/22",
          hideInput && "max-w-0 border-transparent opacity-0 pointer-events-none"
        )}
      >
        <div
          aria-hidden={!chatOpen}
          inert={!chatOpen}
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden transition-[opacity,transform] duration-300 motion-reduce:transition-none",
            chatOpen ? "translate-y-0 opacity-100 delay-100" : "translate-y-2 opacity-0"
          )}
        >
          {chatContent}
        </div>
        {!hideInput && (
          <ChatInput
            className={cn("w-full min-w-0", chatOpen && "px-2 py-1")}
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
            disabled={askDisabled}
            voiceDraft={chatOpen}
            placeholder={t("chat.inputPlaceholder")}
            trailingContent={
              !chatOpen && actionPicker ? <div className="shrink-0">{actionPicker}</div> : null
            }
          />
        )}
      </div>
    </div>
  );
}
