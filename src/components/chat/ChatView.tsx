import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useMainChatSession } from "./useMainChatSession";
import { useInterruptedInteractions } from "./useInterruptedInteractions";
import type { SendToAIOptions } from "./chatTurnEngine";
import {
  useChatTurnStore,
  dropChatConversation,
  returnChatDraft,
  getChatSkills,
} from "../../stores/chatTurnStore";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import ConversationList from "./ConversationList";
import { ConfirmDialog, AlertDialog } from "../ui/dialog";
import { useToast } from "../ui/useToast";
import { PAGE_CONTENT_WIDTH_CLASS } from "../ui/pageWidth";
import { NewChatEmptyState } from "./NewChatEmptyState";
import { CreatorOpening } from "./CreatorOpening";
import { SkillChip } from "./SkillChip";
import { SourceNoteBar } from "./SourceNoteBar";
import type { SourceNote } from "./useSourceNote";
import { deriveConversationTitle } from "../../lib/conversationTitle";
import { SkillChatActionsContext } from "./skillChatActions";
import { useDialogs } from "../../hooks/useDialogs";
import { getCachedPlatform } from "../../utils/platform";
import { observeChatComposerInset } from "./composerLayout";
import { type AttachedSkill } from "./chatSkillMemory";
import type { SkillChatRequest } from "../../types/skills";
import { GitFork } from "../icons";
import { unsentForkContext } from "../../utils/agentSelectionContext";

const CommandSearch = lazy(() => import("../CommandSearch"));

const platform = getCachedPlatform();

interface ChatViewProps {
  /** A new id opens a new chat with that skill attached. */
  skillRequest?: SkillChatRequest | null;
  onSkillRequestHandled?: () => void;
  /** Open skill on a saved skill card. */
  onOpenSkill?: (name: string) => void;
  /** Open note on a chat started from a note. */
  onOpenNote?: (note: SourceNote) => void;
}

export default function ChatView({
  skillRequest = null,
  onSkillRequestHandled,
  onOpenSkill,
  onOpenNote,
}: ChatViewProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const session = useMainChatSession();
  const {
    selection,
    skills: chatSkills,
    newChat: handleNewChat,
    send,
    openConversation,
    setSkills,
    sourceNote,
    forkOrigin,
    forkConversation,
  } = session;
  const activeConversationId = selection.kind === "conversation" ? selection.conversationId : null;
  const isNewChat = selection.kind === "new-chat";
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const { attached: attachedSkill, pickOff: skillPickOff, removed: removedSkills } = chatSkills;
  const {
    confirmDialog,
    showConfirmDialog,
    hideConfirmDialog,
    alertDialog,
    showAlertDialog,
    hideAlertDialog,
  } = useDialogs();
  const handleSelectConversation = useCallback(
    async (id: number): Promise<void> => {
      if ((await openConversation(id, "sidebar")) === null) {
        toast({ title: t("chat.openFailed"), variant: "destructive" });
      }
    },
    [openConversation, t, toast]
  );

  const composerElementRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useCallback((composer: HTMLDivElement | null) => {
    composerElementRef.current = composer;
    const container = composer?.parentElement;
    if (!composer || !container) return;
    return observeChatComposerInset(composer, container);
  }, []);

  const focusComposer = useCallback(() => {
    composerElementRef.current?.querySelector("textarea")?.focus();
  }, []);

  // Starting a new chat from the list or the shortcut means the user is about to type.
  const startNewChat = useCallback(() => {
    handleNewChat();
    focusComposer();
  }, [handleNewChat, focusComposer]);

  // A fork made from selected text sends it with its first request.
  const forkContext = unsentForkContext(forkOrigin, session.messages);
  const sendRequest = useCallback(
    (text: string, options?: SendToAIOptions): Promise<boolean> =>
      send(
        text,
        forkContext
          ? { ...options, selectedContext: { text: forkContext, sourceMessageId: "" } }
          : options
      ),
    [forkContext, send]
  );
  useInterruptedInteractions({ ...session, conversationId: activeConversationId }, sendRequest);

  const sendWithSkill = useCallback(
    async (text: string, skill: AttachedSkill | null): Promise<void> => {
      const before = useChatTurnStore.getState();
      const sent = await sendRequest(text, {
        attachedSkill: skill?.ref,
        allowSkillPick: !skillPickOff,
        removedSkills,
      });
      if (sent) return;
      const after = useChatTurnStore.getState();
      // Nothing went out while the user stayed: the text goes back, and the user hears why.
      if (
        after.accountGeneration === before.accountGeneration &&
        after.selectionRevision === before.selectionRevision
      ) {
        returnChatDraft(before.selection, text);
        toast({ title: t("chat.sendNotStarted"), variant: "destructive" });
      }
    },
    [sendRequest, skillPickOff, removedSkills, t, toast]
  );

  // Read through a ref, so the handler stays the same while a reply streams
  // and every message's memo holds.
  const messagesRef = useRef(session.messages);
  messagesRef.current = session.messages;
  const handleForkMessage = useCallback(
    async (messageId: string) => {
      const message = messagesRef.current.find((m) => m.id === messageId);
      if (!message) return;
      const forkId = await forkConversation(message);
      if (forkId === false) return;
      if (forkId === null) {
        toast({ title: t("chat.forkFailed"), variant: "destructive" });
        return;
      }
      setRefreshKey((k) => k + 1);
    },
    [forkConversation, t, toast]
  );

  const handleContinue = useCallback(() => {
    void sendRequest(t("agentMode.turn.continueMessage"));
  }, [sendRequest, t]);

  const removeSkill = useCallback((): void => {
    const { attached, pickOff, removed } = getChatSkills(useChatTurnStore.getState().selection);
    setSkills({
      attached: null,
      pickOff: pickOff || Boolean(attached?.picked),
      removed: attached && !attached.ref.builtin ? [...removed, attached.ref.name] : removed,
    });
    focusComposer();
  }, [setSkills, focusComposer]);

  // Try now, Create with assistant and Draft with assistant each open a new chat. The request
  // stays set until the parent clears it, so each id is handled once.
  const handledRequestId = useRef<number | null>(null);
  useEffect(() => {
    if (!skillRequest || handledRequestId.current === skillRequest.id) return;
    const request = skillRequest;
    // Handled once this commit is done: React's development build mounts twice, and the first
    // mount's chat session ends with it, which would drop a draft sent from it.
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      handledRequestId.current = request.id;
      startNewChat();
      const skill: AttachedSkill =
        request.kind === "try"
          ? { ref: { name: request.name }, displayName: request.displayName }
          : {
              ref: { name: "skill-creator", builtin: true },
              displayName: t("skills.chat.creatorName"),
            };
      setSkills({
        ...getChatSkills(useChatTurnStore.getState().selection),
        attached: skill,
      });
      if (request.kind === "create" && request.draft) {
        const { title, description, instructions, fileNames } = request.draft;
        const draftText = [
          t("skills.chat.draftPrompt", {
            name: title || t("skills.chat.noneYet"),
            description: description || t("skills.chat.noneYet"),
          }),
          ...(instructions ? [t("skills.chat.draftInstructions", { instructions })] : []),
          ...(fileNames.length > 0
            ? [t("skills.chat.draftFiles", { files: fileNames.join(", ") })]
            : []),
        ].join("\n");
        void sendWithSkill(draftText, skill);
      }
      onSkillRequestHandled?.();
    });
    return () => {
      cancelled = true;
    };
  }, [skillRequest, startNewChat, sendWithSkill, setSkills, onSkillRequestHandled, t]);

  const skillChatActions = useMemo(() => ({ openSkill: onOpenSkill }), [onOpenSkill]);

  const handleArchive = useCallback(
    async (id: number) => {
      const generation = useChatTurnStore.getState().accountGeneration;
      await window.electronAPI?.archiveAgentConversation?.(id);
      if (useChatTurnStore.getState().accountGeneration !== generation) return;
      const current = useChatTurnStore.getState().selection;
      if (current.kind === "conversation" && current.conversationId === id) handleNewChat();
      setRefreshKey((k) => k + 1);
    },
    [handleNewChat]
  );

  const handleUnarchive = useCallback(
    async (id: number) => {
      try {
        await window.electronAPI?.unarchiveAgentConversation?.(id);
        setRefreshKey((k) => k + 1);
      } catch (error) {
        console.error("Failed to unarchive conversation", error);
        toast({ title: t("common.error"), variant: "destructive" });
      }
    },
    [t, toast]
  );

  const handleDelete = useCallback(
    (id: number) => {
      showConfirmDialog({
        title: t("chat.delete"),
        description: t("chat.deleteConfirm"),
        onConfirm: async () => {
          const generation = useChatTurnStore.getState().accountGeneration;
          dropChatConversation(id);
          try {
            await window.electronAPI?.deleteAgentConversation?.(id);
          } catch {
            if (useChatTurnStore.getState().accountGeneration === generation)
              showAlertDialog({ title: t("common.error") });
          }
          setRefreshKey((k) => k + 1);
        },
        variant: "destructive",
      });
    },
    [showConfirmDialog, showAlertDialog, t]
  );

  const openSourceNote = useCallback(
    (note: SourceNote) => {
      if (onOpenNote) onOpenNote(note);
      else void window.electronAPI?.agentOpenNote?.(note.id);
    },
    [onOpenNote]
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "n") {
        e.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [startNewChat]);

  return (
    <>
      <AlertDialog
        open={alertDialog.open}
        onOpenChange={hideAlertDialog}
        onOk={hideAlertDialog}
        title={alertDialog.title}
        description={alertDialog.description}
      />
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
      <SkillChatActionsContext.Provider value={skillChatActions}>
        <div className="flex h-full min-h-0">
          <div className="w-56 min-w-50 shrink-0 border-e border-border dark:border-white/10">
            <ConversationList
              activeConversationId={activeConversationId}
              onSelectConversation={handleSelectConversation}
              onNewChat={startNewChat}
              onOpenSearch={() => setShowSearch(true)}
              onArchive={handleArchive}
              onUnarchive={handleUnarchive}
              onDelete={handleDelete}
              refreshKey={refreshKey}
            />
          </div>
          <div className="relative flex-1 min-w-80 min-h-0 flex flex-col">
            {sourceNote && <SourceNoteBar note={sourceNote} onOpen={openSourceNote} />}
            {forkOrigin?.parentTitle && (
              <div className="px-3 pt-2">
                <button
                  type="button"
                  onClick={() => void handleSelectConversation(forkOrigin.parentConversationId)}
                  className="mx-auto flex max-w-full items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/30"
                >
                  <GitFork size={11} className="shrink-0" />
                  <span dir="auto" className="truncate">
                    {t("chat.forkedFrom", { title: forkOrigin.parentTitle })}
                  </span>
                </button>
              </div>
            )}
            {session.error && (
              <div role="alert" className="px-5 py-3 text-sm text-muted-foreground">
                {session.error}
                {!isNewChat && (
                  <button type="button" onClick={session.retryLoad} className="ms-2 underline">
                    {t("common.retry")}
                  </button>
                )}
              </div>
            )}
            <ChatMessages
              onForkMessage={handleForkMessage}
              onContinue={handleContinue}
              messages={session.messages}
              leading={attachedSkill?.ref.builtin ? <CreatorOpening /> : undefined}
              emptyState={
                session.loading || session.error ? null : (
                  <NewChatEmptyState
                    onPrompt={(prompt) => {
                      if (session.sourceNoteLoading) return;
                      // The starter card unmounts once the message lands; move focus to the
                      // composer first so it isn't dropped.
                      focusComposer();
                      void sendWithSkill(prompt, attachedSkill);
                    }}
                    showSuggestions={isNewChat}
                    disabled={session.sourceNoteLoading || session.agentState !== "idle"}
                  />
                )
              }
              contentClassName={`${PAGE_CONTENT_WIDTH_CLASS} pb-[var(--chat-composer-inset,5rem)]`}
            />
            <div
              ref={composerRef}
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-5 pt-1"
            >
              <ChatInput
                className="pointer-events-auto mx-auto w-full max-w-2xl"
                agentState={session.agentState}
                draftText={session.draft}
                onDraftChange={session.setDraft}
                partialTranscript=""
                sendDisabled={
                  session.loading ||
                  session.sourceNoteLoading ||
                  (!isNewChat && Boolean(session.error))
                }
                onTextSubmit={(text) => {
                  if (!session.sourceNoteLoading) void sendWithSkill(text, attachedSkill);
                }}
                onCancel={session.cancel}
                voiceDraft
                focusOnIdle={false}
                placeholder={
                  attachedSkill && !attachedSkill.ref.builtin
                    ? t("skills.chat.placeholderWith", { name: attachedSkill.displayName })
                    : session.sourceNoteGrounds && sourceNote
                      ? t("chat.sourceNote.askAbout", {
                          // The placeholder is one line and clips; its own "..." ends a shortened title.
                          title: deriveConversationTitle(
                            sourceNote.title,
                            t("notes.list.untitledNote"),
                            ""
                          ),
                        })
                      : t("chat.inputPlaceholder")
                }
                variant="assistant"
                expandOnFocus
                leadingRow={
                  attachedSkill && (
                    <SkillChip
                      key={attachedSkill.ref.name}
                      name={attachedSkill.displayName}
                      onRemove={removeSkill}
                    />
                  )
                }
              />
            </div>
          </div>
        </div>
      </SkillChatActionsContext.Provider>
    </>
  );
}
