import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Plus } from "../icons";
import { cn } from "../lib/utils";
import { ChatMessages } from "../chat/ChatMessages";
import { ChatInput } from "../chat/ChatInput";
import type { SlashCommand } from "../chat/slashCommands";
import { BrandMarkIcon } from "../dictation/BrandMarkIcon";
import type { Message, AgentState } from "../chat/types";
import { setActiveNoteId, setActiveFolderId } from "../../stores/noteStore";
import type { ContainerConversationItem } from "../../hooks/useContainerChat";
import { ConversationPicker } from "./ConversationPicker";
import { PanelResizeHandle } from "../ui/PanelResizeHandle";
import { useResizableWidth } from "../../hooks/useResizableWidth";

/** Closed, the ask bar open over the note (floating), or the chat docked beside it (sidebar). */
export type EmbeddedChatMode = "hidden" | "floating" | "sidebar";

interface EmbeddedChatProps {
  onClose: () => void;
  messages: Message[];
  agentState: AgentState;
  draftText?: string;
  onDraftChange?: (text: string) => void;
  onTextSubmit: (text: string) => void;
  onCancel: () => void;
  noteConversations: ContainerConversationItem[];
  activeConversationId: number | null;
  onSwitchConversation: (id: number) => void;
  onNewChat: () => void;
  /** Shown in the tray above the composer. */
  actionChips?: React.ReactNode;
  slashCommands?: SlashCommand[];
}

// The share of the row the CSS lets the chat take: 70%, or half below the `lg` breakpoint.
function chatMaxWidth(panel: HTMLElement): number {
  const share = window.matchMedia("(min-width: 1024px)").matches ? 0.7 : 0.5;
  return Math.floor((panel.parentElement?.clientWidth ?? Infinity) * share);
}

/** The note's chat, docked beside it: the conversation, its history and a composer. */
export default function EmbeddedChat({
  onClose,
  messages,
  agentState,
  draftText,
  onDraftChange,
  onTextSubmit,
  onCancel,
  noteConversations,
  activeConversationId,
  onSwitchConversation,
  onNewChat,
  actionChips,
  slashCommands,
}: EmbeddedChatProps) {
  const { t } = useTranslation();
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const resize = useResizableWidth<HTMLDivElement>({
    storageKey: "noteChatWidth",
    edge: "start",
    min: 320,
    max: 1200,
    getDragMax: chatMaxWidth,
  });

  const handleOpenNote = useCallback(async (noteId: number) => {
    const note = await window.electronAPI.getNote(noteId);
    if (note?.folder_id) setActiveFolderId(note.folder_id);
    setActiveNoteId(noteId);
  }, []);

  return (
    <div
      ref={resize.panelRef}
      // Half the note view until it's resized; resized, it can take 70%, and the note keeps the rest.
      // Its minimum is never more than half the row, and in a narrow window (a meeting's side
      // panel) it takes at most half.
      className={cn(
        "relative flex min-h-0 min-w-[min(20rem,50%)] shrink-0 p-3 max-lg:max-w-[50%]",
        resize.width === null ? "w-1/2 max-w-2xl" : "max-w-[70%]"
      )}
      style={resize.width === null ? undefined : { width: resize.width }}
      data-note-chat-panel
    >
      <PanelResizeHandle
        edge="start"
        isResizing={resize.isResizing}
        onPointerDown={resize.startResize}
        // Fills the gutter between the note and the chat.
        className="w-3"
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[20px] border border-border/60 bg-surface-1 dark:border-white/10 dark:bg-surface-1">
        <div className={cn("flex min-h-0 flex-1 flex-col", slashMenuOpen && "hidden")}>
          <div className="flex h-14 shrink-0 items-center px-5">
            <ConversationPicker
              conversations={noteConversations}
              activeConversationId={activeConversationId}
              onSwitchConversation={onSwitchConversation}
              onNewChat={onNewChat}
              titleClassName="max-w-32"
              variant="sidebar"
            />
            <div className="flex-1" />
            {/* The icons sit as far from the right edge as the clock does from the left. */}
            <div className="-me-2 flex items-center gap-3">
              <button
                onClick={onNewChat}
                className="flex size-8 items-center justify-center rounded-full text-foreground/65 transition-colors hover:bg-foreground/6 hover:text-foreground"
                aria-label={t("embeddedChat.newChat")}
              >
                <Plus size={16} />
              </button>
              <button
                onClick={onClose}
                className="flex size-8 items-center justify-center rounded-full text-foreground/45 transition-colors hover:bg-foreground/6 hover:text-foreground"
                aria-label={t("embeddedChat.close")}
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col **:data-chat-bubble:max-w-full">
            <ChatMessages
              messages={messages}
              emptyState={
                <div className="flex h-full min-h-40 select-none items-center justify-center">
                  <BrandMarkIcon
                    size={72}
                    className="text-foreground/10 drop-shadow-sm dark:text-foreground/15"
                  />
                </div>
              }
              onOpenNote={handleOpenNote}
              plainBubbles
              scrollClassName={messages.length === 0 ? "scrollbar-hidden" : undefined}
            />
          </div>
        </div>
        {/* One tray holds the chips and the composer. */}
        <div
          className={cn(
            "mx-3 mb-3 rounded-[18px] border border-black/[0.06] bg-foreground/[0.04] p-0.5 dark:border-white/[0.06] dark:bg-white/[0.05]",
            slashMenuOpen ? "mt-3 flex min-h-0 flex-1 flex-col" : "shrink-0"
          )}
        >
          {actionChips && !slashMenuOpen && <div className="px-1.5 pt-1 pb-1">{actionChips}</div>}
          <ChatInput
            className="w-full"
            variant="sidebar"
            agentState={agentState}
            draftText={draftText}
            onDraftChange={onDraftChange}
            partialTranscript=""
            onTextSubmit={onTextSubmit}
            onCancel={onCancel}
            voiceDraft
            // It opens from a send in the ask bar, and the conversation moves here.
            autoFocus
            focusOnIdle={false}
            placeholder={t("embeddedChat.askPlaceholder")}
            slashCommands={slashCommands}
            onSlashMenuOpenChange={setSlashMenuOpen}
          />
        </div>
      </div>
    </div>
  );
}
