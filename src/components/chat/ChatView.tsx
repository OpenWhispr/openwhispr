import { useState, useCallback, useEffect, useMemo, useRef, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { useChatPersistence } from "./useChatPersistence";
import { useChatStreaming } from "./useChatStreaming";
import { useChatMessageSender } from "./useChatMessageSender";
import { useInterruptedInteractions } from "./useInterruptedInteractions";
import type { SendToAIOptions } from "./useChatStreaming";
import { ChatMessages } from "./ChatMessages";
import { ChatInput } from "./ChatInput";
import ConversationList from "./ConversationList";
import { ConfirmDialog } from "../ui/dialog";
import { PAGE_CONTENT_WIDTH_CLASS } from "../ui/pageWidth";
import { NewChatEmptyState } from "./NewChatEmptyState";
import { CreatorOpening } from "./CreatorOpening";
import { SkillChip } from "./SkillChip";
import { SkillChatActionsContext } from "./skillChatActions";
import { useDialogs } from "../../hooks/useDialogs";
import { getCachedPlatform } from "../../utils/platform";
import { observeChatComposerInset } from "./composerLayout";
import { useToast } from "../ui/useToast";
import { GitFork } from "../icons";
import { normalizeAgentSelectionContext } from "../../utils/agentSelectionContext";
import {
  NO_CHAT_SKILLS,
  forgetChatSkills,
  readChatSkills,
  writeChatSkills,
  type AttachedSkill,
  type ChatSkills,
} from "./chatSkillMemory";
import type { SkillChatRequest } from "../../types/skills";

const CommandSearch = lazy(() => import("../CommandSearch"));

const platform = getCachedPlatform();

interface ChatViewProps {
  /**
   * False while another Control Panel view shows. The chat stays mounted so a
   * turn waiting on the user (a trip to Settings) survives.
   */
  active?: boolean;
  /** Bumped to start a new chat from outside (the New chat menu). */
  newChatRequest?: number;
  /** A new id opens a new chat with that skill attached. */
  skillRequest?: SkillChatRequest | null;
  onSkillRequestHandled?: () => void;
  /** Open skill on a saved skill card. */
  onOpenSkill?: (name: string) => void;
}
export default function ChatView({
  active = true,
  newChatRequest = 0,
  skillRequest = null,
  onSkillRequestHandled,
  onOpenSkill,
}: ChatViewProps) {
  const { t } = useTranslation();
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const [isNewChat, setIsNewChat] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  // A conversation's skills come back with it when the user returns to it.
  const [chatSkills, setChatSkills] = useState<ChatSkills>(NO_CHAT_SKILLS);
  const { attached: attachedSkill, pickOff: skillPickOff, removed: removedSkills } = chatSkills;
  const { confirmDialog, showConfirmDialog, hideConfirmDialog } = useDialogs();
  const { toast } = useToast();

  const persistence = useChatPersistence({
    conversationId: activeConversationId,
    onConversationCreated: (id) => {
      setActiveConversationId(id);
      setRefreshKey((k) => k + 1);
    },
  });

  const streaming = useChatStreaming({
    setMessages: persistence.setMessages,
    allowConnectors: true,
    allowInteractions: true,
    onStreamComplete: persistence.saveAssistantMessage,
    onTurnCheckpoint: persistence.saveAssistantMessage,
    skillsEnabled: true,
  });
  // useChatStreaming returns a fresh object every render; cancelStream is
  // stable, so the callbacks below depend on it rather than on `streaming`.
  const { cancelStream } = streaming;

  const handleSelectConversation = useCallback(
    async (id: number) => {
      if (id === activeConversationId) return;
      cancelStream();
      setActiveConversationId(id);
      setIsNewChat(false);
      setChatSkills(readChatSkills(id));
      if ((await persistence.loadConversation(id)) === null) {
        setActiveConversationId(null);
        setIsNewChat(true);
        setChatSkills(NO_CHAT_SKILLS);
      }
    },
    [activeConversationId, cancelStream, persistence]
  );

  const handleNewChat = useCallback(() => {
    cancelStream();
    setActiveConversationId(null);
    setIsNewChat(true);
    setChatSkills(NO_CHAT_SKILLS);
    persistence.handleNewChat();
  }, [cancelStream, persistence]);

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

  const createConversation = useCallback(
    async (text: string) => {
      const title = text.length > 50 ? `${text.slice(0, 50)}...` : text;
      return persistence.createConversation(title);
    },
    [persistence]
  );
  const sendMessage = useChatMessageSender({
    conversationId: activeConversationId,
    persistence,
    streaming,
    createConversation,
    onSendingChange: setSubmissionInFlight,
  });
  // A fork made from selected text sends it with its first request.
  const { forkOrigin } = persistence;
  const forkSelection = normalizeAgentSelectionContext({
    text: forkOrigin?.context ?? undefined,
  })?.text;
  const forkContext =
    forkSelection &&
    !persistence.messages.some(
      (message) => message.role === "user" && message.selectedContext === forkSelection
    )
      ? forkSelection
      : null;
  const handleTextSubmit = useCallback(
    (text: string, options?: SendToAIOptions) =>
      sendMessage(
        text,
        forkContext
          ? { ...options, selectedContext: { text: forkContext, sourceMessageId: "" } }
          : options
      ),
    [forkContext, sendMessage]
  );
  useInterruptedInteractions(persistence, handleTextSubmit);

  // Read through a ref, so the handler stays the same while a reply streams
  // and every message's memo holds.
  const messagesRef = useRef(persistence.messages);
  messagesRef.current = persistence.messages;
  const { forkConversation } = persistence;
  const handleForkMessage = useCallback(
    async (messageId: string) => {
      const message = messagesRef.current.find((m) => m.id === messageId);
      if (!message) return;
      cancelStream();
      const forkId = await forkConversation(message);
      if (forkId === false) return;
      if (forkId === null) {
        toast({ title: t("chat.forkFailed"), variant: "destructive" });
        return;
      }
      setActiveConversationId(forkId);
      setIsNewChat(false);
      setRefreshKey((k) => k + 1);
    },
    [cancelStream, forkConversation, t, toast]
  );

  const handleContinue = useCallback(() => {
    void handleTextSubmit(t("agentMode.turn.continueMessage"));
  }, [handleTextSubmit, t]);

  // Every send carries the chat's skill, and lets the app pick one until the user said no.
  const sendWithSkill = useCallback(
    (text: string, skill: AttachedSkill | null) =>
      handleTextSubmit(text, {
        attachedSkill: skill?.ref,
        allowSkillPick: !skillPickOff,
        removedSkills,
        onSkillPicked: ({ name, displayName }) =>
          setChatSkills((skills) => ({
            ...skills,
            attached: { ref: { name }, displayName, picked: true },
          })),
      }),
    [handleTextSubmit, skillPickOff, removedSkills]
  );

  const removeSkill = useCallback(() => {
    setChatSkills(({ attached, pickOff, removed }) => ({
      attached: null,
      pickOff: pickOff || Boolean(attached?.picked),
      removed: attached && !attached.ref.builtin ? [...removed, attached.ref.name] : removed,
    }));
    // The × is gone with the chip, so the cursor goes back to the composer.
    focusComposer();
  }, [focusComposer]);

  useEffect(() => {
    if (activeConversationId !== null) writeChatSkills(activeConversationId, chatSkills);
  }, [activeConversationId, chatSkills]);

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
      setChatSkills((skills) => ({ ...skills, attached: skill }));
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
  }, [skillRequest, startNewChat, sendWithSkill, onSkillRequestHandled, t]);

  // Open skill leaves the chat, which ends a running turn; a turn that so far holds only the
  // card's tool call isn't saved then, so the link waits for the turn to finish.
  const turnRunning = submissionInFlight || streaming.agentState !== "idle";
  const skillChatActions = useMemo(
    () => ({ openSkill: turnRunning ? undefined : onOpenSkill }),
    [turnRunning, onOpenSkill]
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
          forgetChatSkills(id);
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
    if (!active) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = platform === "darwin" ? e.metaKey : e.ctrlKey;
      if (mod && e.key === "n") {
        e.preventDefault();
        startNewChat();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, startNewChat]);

  // Back from another view: chats may have been added meanwhile.
  const wasActiveRef = useRef(active);
  useEffect(() => {
    if (active && !wasActiveRef.current) setRefreshKey((k) => k + 1);
    wasActiveRef.current = active;
  }, [active]);

  const handledNewChatRequestRef = useRef(newChatRequest);
  useEffect(() => {
    if (newChatRequest === handledNewChatRequestRef.current) return;
    handledNewChatRequestRef.current = newChatRequest;
    startNewChat();
  }, [newChatRequest, startNewChat]);

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
      <SkillChatActionsContext.Provider value={skillChatActions}>
        <div className="flex h-full min-h-0">
          <div className="w-56 min-w-50 shrink-0 border-e border-border dark:border-white/10">
            <ConversationList
              activeConversationId={activeConversationId}
              onSelectConversation={handleSelectConversation}
              onNewChat={startNewChat}
              onOpenSearch={() => setShowSearch(true)}
              onArchive={handleArchive}
              onDelete={handleDelete}
              refreshKey={refreshKey}
            />
          </div>
          <div className="relative flex-1 min-w-80 min-h-0 flex flex-col">
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
            <ChatMessages
              onForkMessage={handleForkMessage}
              onContinue={handleContinue}
              messages={persistence.messages}
              leading={attachedSkill?.ref.builtin ? <CreatorOpening /> : undefined}
              emptyState={
                <NewChatEmptyState
                  onPrompt={(prompt) => {
                    // The starter card unmounts once the message lands; move focus to the
                    // composer first so it isn't dropped.
                    focusComposer();
                    void sendWithSkill(prompt, attachedSkill);
                  }}
                  showSuggestions={isNewChat}
                  disabled={submissionInFlight || streaming.agentState !== "idle"}
                />
              }
              contentClassName={`${PAGE_CONTENT_WIDTH_CLASS} pb-[var(--chat-composer-inset,5rem)]`}
            />
            <div
              ref={composerRef}
              className="pointer-events-none absolute inset-x-0 bottom-0 z-10 px-3 pb-5 pt-1"
            >
              <ChatInput
                className="pointer-events-auto mx-auto w-full max-w-2xl"
                // New chat and switching cancel the stream at once, but the
                // cancelled send can hold the submission lock until an
                // in-flight tool returns; a message sent before then would
                // be dropped, so the input stays busy until it lets go.
                agentState={
                  submissionInFlight && streaming.agentState === "idle"
                    ? "thinking"
                    : streaming.agentState
                }
                partialTranscript=""
                onTextSubmit={(text) => void sendWithSkill(text, attachedSkill)}
                onCancel={streaming.cancelStream}
                voiceDraft
                focusOnIdle={false}
                placeholder={
                  attachedSkill && !attachedSkill.ref.builtin
                    ? t("skills.chat.placeholderWith", { name: attachedSkill.displayName })
                    : t("chat.inputPlaceholder")
                }
                variant="assistant"
                expandOnFocus
                active={active}
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
