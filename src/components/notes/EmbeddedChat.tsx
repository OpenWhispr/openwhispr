import { useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X, PanelRight, PanelRightClose } from "../icons";
import { cn } from "../lib/utils";
import { ChatMessages } from "../chat/ChatMessages";
import { ChatInput } from "../chat/ChatInput";
import { ChatEmptyIllustration } from "../chat/ChatEmptyIllustration";
import { BrandMarkIcon } from "../dictation/BrandMarkIcon";
import type { Message, AgentState } from "../chat/types";
import { setActiveNoteId, setActiveFolderId } from "../../stores/noteStore";
import type { ContainerConversationItem } from "../../hooks/useContainerChat";
import { ConversationPicker } from "./ConversationPicker";

export type EmbeddedChatMode = "hidden" | "floating" | "sidebar";

interface EmbeddedChatProps {
  mode: EmbeddedChatMode;
  onModeChange: (mode: EmbeddedChatMode) => void;
  messages: Message[];
  agentState: AgentState;
  draftText: string;
  onDraftChange: (text: string) => void;
  onTextSubmit: (text: string) => void;
  onCancel: () => void;
  noteConversations?: ContainerConversationItem[];
  activeConversationId?: number | null;
  onSwitchConversation?: (id: number) => void;
  onNewChat?: () => void;
  active?: boolean;
}

function EmptyState({ floating }: { floating: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-3 px-4 text-center select-none",
        floating ? "min-h-48" : "min-h-40"
      )}
    >
      {floating ? (
        <BrandMarkIcon size={36} className="text-foreground/20 dark:text-muted-foreground/35" />
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-card dark:border-white/10">
          <ChatEmptyIllustration size={38} />
        </div>
      )}
      <p
        className={cn("text-muted-foreground", floating ? "max-w-64 text-sm" : "max-w-44 text-xs")}
      >
        {t("embeddedChat.emptyState")}
      </p>
    </div>
  );
}

export default function EmbeddedChat({
  mode,
  onModeChange,
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
  active = true,
}: EmbeddedChatProps) {
  const { t } = useTranslation();

  const handleOpenNote = useCallback(async (noteId: number) => {
    const note = await window.electronAPI.getNote(noteId);
    if (note?.folder_id) setActiveFolderId(note.folder_id);
    setActiveNoteId(noteId);
  }, []);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && mode === "floating" && active) {
        onModeChange("hidden");
      }
    },
    [mode, onModeChange, active]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (mode === "hidden") return null;

  const hasConversationSelector =
    noteConversations !== undefined && onSwitchConversation !== undefined;

  const headerTitle = hasConversationSelector ? (
    <ConversationPicker
      conversations={noteConversations}
      activeConversationId={activeConversationId}
      onSwitchConversation={onSwitchConversation}
      onNewChat={onNewChat}
      titleClassName="max-w-32"
    />
  ) : (
    <span className="text-xs font-medium text-foreground/50">{t("embeddedChat.title")}</span>
  );

  const header = (
    <div
      data-note-chat-header={mode === "floating" ? "" : undefined}
      className={cn(
        "h-9 flex items-center px-3 shrink-0",
        mode === "sidebar" && "border-b border-border/70 dark:border-white/10"
      )}
    >
      {headerTitle}
      <div className="flex-1" />
      <div className="flex items-center gap-0.5">
        {mode === "floating" ? (
          <button
            onClick={() => onModeChange("sidebar")}
            className="h-6 w-6 flex items-center justify-center rounded-md text-foreground/45 hover:bg-foreground/6 transition-colors"
            aria-label={t("embeddedChat.dock")}
          >
            <PanelRight size={13} className="rtl:scale-x-[-1]" />
          </button>
        ) : (
          <button
            onClick={() => onModeChange("floating")}
            className="h-6 w-6 flex items-center justify-center rounded-md text-foreground/45 hover:bg-foreground/6 transition-colors"
            aria-label={t("embeddedChat.undock")}
          >
            <PanelRightClose size={13} className="rtl:scale-x-[-1]" />
          </button>
        )}
        <button
          onClick={() => onModeChange("hidden")}
          className="h-6 w-6 flex items-center justify-center rounded-md text-foreground/45 hover:bg-foreground/6 transition-colors"
          aria-label={t("embeddedChat.close")}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );

  const chatBody = (
    <>
      {header}
      <div
        className={cn(
          "flex-1 min-h-0 flex flex-col **:data-chat-bubble:max-w-full",
          mode === "floating" && "min-w-0 max-w-full **:data-chat-bubble:break-words"
        )}
      >
        <ChatMessages
          messages={messages}
          emptyState={<EmptyState floating={mode === "floating"} />}
          onOpenNote={handleOpenNote}
          scrollClassName={
            mode === "floating"
              ? cn(
                  "min-w-0 max-w-full overflow-x-hidden",
                  messages.length === 0 && "scrollbar-hidden"
                )
              : undefined
          }
        />
      </div>
    </>
  );

  if (mode === "floating") {
    return chatBody;
  }

  return (
    <div
      className={cn(
        "w-2/5 min-w-72 max-w-2xl shrink-0",
        "border-s border-black/12 dark:border-white/14",
        "bg-surface-1 dark:bg-surface-2",
        "flex flex-col",
        "min-h-0"
      )}
    >
      {chatBody}
      <ChatInput
        agentState={agentState}
        draftText={draftText}
        onDraftChange={onDraftChange}
        partialTranscript=""
        onTextSubmit={onTextSubmit}
        onCancel={onCancel}
        voiceDraft
      />
    </div>
  );
}
