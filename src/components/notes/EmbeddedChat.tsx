import { useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { X, PanelRight, Plus, AlignLeft, ClipboardCheck, FileText } from "../icons";
import { cn } from "../lib/utils";
import { ChatMessages } from "../chat/ChatMessages";
import { ChatInput } from "../chat/ChatInput";
import { BrandMarkIcon } from "../dictation/BrandMarkIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type { Message, AgentState } from "../chat/types";
import { setActiveNoteId, setActiveFolderId } from "../../stores/noteStore";
import type { ContainerConversationItem } from "../../hooks/useContainerChat";
import { ConversationPicker } from "./ConversationPicker";

export type EmbeddedChatMode = "hidden" | "floating" | "sidebar";

const SIDEBAR_PROMPTS = [
  { key: "embeddedChat.generateSummary", icon: AlignLeft },
  { key: "embeddedChat.makeTodos", icon: ClipboardCheck },
  { key: "embeddedChat.createOutline", icon: FileText },
] as const;

interface EmbeddedChatProps {
  mode: EmbeddedChatMode;
  onModeChange: (mode: EmbeddedChatMode) => void;
  messages: Message[];
  agentState: AgentState;
  draftText?: string;
  onDraftChange?: (text: string) => void;
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
        <>
          <BrandMarkIcon size={36} className="text-foreground/20 dark:text-muted-foreground/35" />
          <p className="max-w-64 text-sm text-muted-foreground">{t("embeddedChat.emptyState")}</p>
        </>
      ) : (
        <BrandMarkIcon
          size={72}
          className="text-foreground/10 drop-shadow-sm dark:text-foreground/15"
        />
      )}
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
      variant={mode === "sidebar" ? "sidebar" : "default"}
      onUndock={mode === "sidebar" ? () => onModeChange("floating") : undefined}
    />
  ) : (
    <span className="text-xs font-medium text-foreground/50">
      {t(mode === "sidebar" ? "embeddedChat.history" : "embeddedChat.title")}
    </span>
  );

  const header = (
    <div
      className={cn("flex items-center shrink-0", mode === "sidebar" ? "h-16 px-6" : "h-9 px-3")}
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
        ) : null}
        {mode === "sidebar" && onNewChat && (
          <button
            onClick={onNewChat}
            className="flex size-8 items-center justify-center rounded-full text-foreground/65 transition-colors hover:bg-foreground/6 hover:text-foreground"
            aria-label={t("embeddedChat.newChat")}
          >
            <Plus size={18} />
          </button>
        )}
        <button
          onClick={() => onModeChange("hidden")}
          className={cn(
            "flex items-center justify-center text-foreground/45 transition-colors hover:bg-foreground/6 hover:text-foreground",
            mode === "sidebar" ? "size-8 rounded-full" : "h-6 w-6 rounded-md"
          )}
          aria-label={t("embeddedChat.close")}
        >
          <X size={mode === "sidebar" ? 18 : 13} />
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
              : messages.length === 0
                ? "scrollbar-hidden"
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
    <div className="flex min-h-0 w-1/2 min-w-80 max-w-2xl shrink-0 p-4" data-note-chat-panel>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-4xl border border-border/60 bg-surface-1 dark:border-white/10 dark:bg-surface-1">
        {chatBody}
        <div className="mx-3 mb-3 shrink-0">
          <div className="scrollbar-hidden flex items-center gap-1.5 overflow-x-auto px-1 pb-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={agentState !== "idle"}
                  aria-label={t("embeddedChat.quickActions")}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-foreground/35 bg-background text-foreground/55 transition-colors hover:text-foreground disabled:opacity-40 dark:bg-surface-2"
                >
                  <Plus size={14} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" sideOffset={8}>
                {SIDEBAR_PROMPTS.map(({ key, icon: Icon }) => (
                  <DropdownMenuItem key={key} onClick={() => onTextSubmit(t(key))}>
                    <Icon size={15} className="text-primary" />
                    {t(key)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {SIDEBAR_PROMPTS.map(({ key, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => onTextSubmit(t(key))}
                disabled={agentState !== "idle"}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 text-xs text-foreground/65 transition-colors hover:text-foreground disabled:opacity-40 dark:border-white/10 dark:bg-surface-2"
              >
                <Icon size={14} className="text-primary" />
                {t(key)}
              </button>
            ))}
          </div>
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
            focusOnIdle={false}
            placeholder={t("chat.inputPlaceholder")}
          />
        </div>
      </div>
    </div>
  );
}
