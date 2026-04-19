import { useState, useCallback, useEffect, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useChatPersistence } from "./useChatPersistence";
import { useChatStreaming } from "./useChatStreaming";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import { ChatEmptyIllustration } from "./ChatEmptyIllustration";
import ConversationList from "./ConversationList";
import EmptyChatState from "./EmptyChatState";
import { ConfirmDialog } from "../ui/dialog";
import { useDialogs } from "../../hooks/useDialogs";
import { getCachedPlatform } from "../../utils/platform";

const CommandSearch = lazy(() => import("../CommandSearch"));

const platform = getCachedPlatform();

function NewChatEmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full -mt-6 select-none">
      <ChatEmptyIllustration />
      <p className="text-xs text-foreground/50 dark:text-foreground/25 text-center max-w-48 mt-4">
        {t("chat.newChatEmpty")}
      </p>
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

  const handleTextSubmit = useCallback(
    async (text: string) => {
      setIsNewChat(false);
      let convId = activeConversationId;
      if (!convId) {
        const title = text.length > 50 ? `${text.slice(0, 50)}...` : text;
        convId = await persistence.createConversation(title);
      }

      const userMsg = {
        id: crypto.randomUUID(),
        role: "user" as const,
        content: text,
        isStreaming: false,
      };
      persistence.setMessages((prev) => [...prev, userMsg]);
      await persistence.saveUserMessage(text);

      const allMessages = [...persistence.messages, userMsg];
      await streaming.sendToAI(text, allMessages);
    },
    [activeConversationId, persistence, streaming]
  );

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
      <div className="flex h-full">
        <div className="w-56 min-w-50 shrink-0 border-r border-border/15 dark:border-white/6">
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
        <div className="flex-1 min-w-80 flex flex-col">
          {hasActiveChat ? (
            <>
              <ChatMessages messages={persistence.messages} emptyState={<NewChatEmptyState />} />
              <ChatInput
                agentState={streaming.agentState}
                partialTranscript=""
                onTextSubmit={handleTextSubmit}
                onCancel={streaming.cancelStream}
                autoFocus={isNewChat}
              />
            </>
          ) : (
            <EmptyChatState />
          )}
        </div>
      </div>
    </>
  );
}
