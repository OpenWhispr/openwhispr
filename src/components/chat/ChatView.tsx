import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useChatPersistence } from "./useChatPersistence";
import { useChatStreaming } from "./useChatStreaming";
import { useChatMessageSender } from "./useChatMessageSender";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import ConversationList from "./ConversationList";
import EmptyChatState from "./EmptyChatState";
import { ConfirmDialog } from "../ui/dialog";
import { PAGE_CONTENT_WIDTH_CLASS } from "../ui/pageWidth";
import { BrandMarkIcon } from "../dictation/BrandMarkIcon";
import { useDialogs } from "../../hooks/useDialogs";
import { getCachedPlatform } from "../../utils/platform";
import { Check, FileText, Video } from "../icons";
import { observeChatComposerInset } from "./composerLayout";

const CommandSearch = lazy(() => import("../CommandSearch"));

const platform = getCachedPlatform();

const STARTER_PROMPTS = [
  { key: "chat.starters.todos", icon: Check },
  { key: "chat.starters.meeting", icon: Video },
  { key: "chat.starters.sharedNotes", icon: FileText },
] as const;

function NewChatEmptyState({
  onPrompt,
  showSuggestions,
  disabled,
}: {
  onPrompt: (prompt: string) => void;
  showSuggestions: boolean;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-80 flex-col items-center justify-center px-4 text-center">
      <BrandMarkIcon size={64} className="text-foreground/15 dark:text-muted-foreground/35" />
      {showSuggestions && (
        <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
          {STARTER_PROMPTS.map(({ key, icon: Icon }) => (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => onPrompt(t(key))}
              className="flex min-h-24 flex-col items-start justify-between rounded-2xl border border-border bg-card p-4 text-start text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10"
            >
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Icon size={16} />
              </span>
              <span className="max-w-full truncate" title={t(key)}>
                {t(key)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ChatView() {
  const { t } = useTranslation();
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [isNewChat, setIsNewChat] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();

  const persistence = useChatPersistence({
    conversationId: activeConversationId,
    onConversationCreated: (id) => {
      setActiveConversationId(id);
      setRefreshKey((k) => k + 1);
    },
  });

  const streaming = useChatStreaming({
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    onStreamComplete: (_id, content, toolCalls) => {
      persistence.saveAssistantMessage(content, toolCalls);
    },
  });

  const handleSelectConversation = useCallback(
    async (id: number) => {
      if (id === activeConversationId) return;
      setActiveConversationId(id);
      setIsNewChat(false);
      await persistence.loadConversation(id);
    },
    [activeConversationId, persistence]
  );

  const handleNewChat = useCallback(() => {
    setActiveConversationId(null);
    setIsNewChat(true);
    persistence.handleNewChat();
  }, [persistence]);

  const createConversation = useCallback(
    async (text: string) => {
      const title = text.length > 50 ? `${text.slice(0, 50)}...` : text;
      return persistence.createConversation(title);
    },
    [persistence]
  );
  const markChatStarted = useCallback(() => setIsNewChat(false), []);
  const handleTextSubmit = useChatMessageSender({
    conversationId: activeConversationId,
    persistence,
    streaming,
    createConversation,
    onBeforeSend: markChatStarted,
  });

  const handleArchive = useCallback(
    async (id: number) => {
      await window.electronAPI?.archiveAgentConversation?.(id);
      if (activeConversationId === id) {
        handleNewChat();
      }
      setRefreshKey((k) => k + 1);
    },
    [activeConversationId, handleNewChat]
  );

  const handleDelete = useCallback(
    (id: number) => {
      showConfirmDialog({
        title: t("chat.delete"),
        description: t("chat.deleteConfirm"),
        onConfirm: async () => {
          await window.electronAPI?.deleteAgentConversation?.(id);
          if (activeConversationId === id) {
            handleNewChat();
          }
          setRefreshKey((k) => k + 1);
        },
        variant: "destructive",
      });
    },
    [activeConversationId, handleNewChat, showConfirmDialog, t]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "n") {
        e.preventDefault();
        handleNewChat();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleNewChat]);

  const hasActiveChat =
    activeConversationId !== null || persistence.messages.length > 0 || isNewChat;

  const composerRef = useCallback((composer: HTMLDivElement | null) => {
    const container = composer?.parentElement;
    if (!composer || !container) return;
    return observeChatComposerInset(composer, container);
  }, []);

  return (
    <>
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={hideConfirmDialog}
        title={confirmDialog.title}
        description={confirmDialog.description}
        onConfirm={confirmDialog.onConfirm}
        variant={confirmDialog.variant}
      />
      {showSearch && (
        <Suspense fallback={null}>
          <CommandSearch
            open={showSearch}
            onOpenChange={setShowSearch}
            mode="conversations"
            onConversationSelect={handleSelectConversation}
          />
        </Suspense>
      )}
      <div className="flex h-full min-h-0">
        <div className="w-56 min-w-50 shrink-0 border-e border-border dark:border-white/10">
          <ConversationList
            activeConversationId={activeConversationId}
            onSelectConversation={handleSelectConversation}
            onNewChat={handleNewChat}
            onOpenSearch={() => setShowSearch(true)}
            onArchive={handleArchive}
            onDelete={handleDelete}
            refreshKey={refreshKey}
          />
        </div>
        <div className="relative flex-1 min-w-80 min-h-0 flex flex-col">
          {hasActiveChat ? (
            <>
              <ChatMessages
                messages={persistence.messages}
                emptyState={
                  <NewChatEmptyState
                    onPrompt={(prompt) => void handleTextSubmit(prompt)}
                    showSuggestions={isNewChat}
                    disabled={streaming.agentState !== "idle"}
                  />
                }
                contentClassName={`${PAGE_CONTENT_WIDTH_CLASS} pb-[var(--chat-composer-inset,5rem)]`}
              />
              <div ref={composerRef} className="absolute inset-x-0 bottom-0 z-10 px-3 pb-5 pt-1">
                <ChatInput
                  className="mx-auto w-full max-w-2xl"
                  agentState={streaming.agentState}
                  partialTranscript=""
                  onTextSubmit={handleTextSubmit}
                  onCancel={streaming.cancelStream}
                  autoFocus={isNewChat}
                  placeholder={t("chat.inputPlaceholder")}
                  variant="assistant"
                />
              </div>
            </>
          ) : (
            <EmptyChatState />
          )}
        </div>
      </div>
    </>
  );
}
