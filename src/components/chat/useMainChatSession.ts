import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import i18n from "../../i18n";
import { useAuth } from "../../hooks/useAuth";
import {
  useChatTurnStore,
  chatSelectionKey,
  chatSelectionToken,
  selectChat,
  startNewChat,
  startChatSend,
  cancelChatTurn,
  dropChatConversation,
  acceptChatConversation,
  takeCompletedChatTurn,
  setChatDraft,
  setChatSkills,
  getChatSkills,
  resolveChatSkills,
  claimChatConversation,
  releaseChatConversation,
  type ChatSelection,
} from "../../stores/chatTurnStore";
import {
  decodeChatMessages,
  forkOriginOf,
  replyMetadata,
  saveReplyRow,
  type ForkOrigin,
  type StoredChatConversation,
} from "./chatPersistence";
import type { SendToAIOptions, TurnDetails } from "./chatTurnEngine";
import { useSourceNote, type SourceNote } from "./useSourceNote";
import type { ChatSkills } from "./chatSkillMemory";
import type { AgentState, Message, ToolCallInfo } from "./types";

interface LoadedSnapshot {
  token: string;
  messages: Message[];
  error: string | null;
  noteId: number | null;
  forkOrigin: ForkOrigin | null;
  /** Another window runs this conversation or holds its question: shown as saved, reloaded once it lets go. */
  blocked?: boolean;
}
export interface MainChatSession {
  selection: ChatSelection;
  loading: boolean;
  messages: Message[];
  agentState: AgentState;
  toolStatus: string;
  activeToolName: string;
  skills: ChatSkills;
  draft: string;
  error: string | null;
  sourceNote: SourceNote | null;
  sourceNoteLoading: boolean;
  sourceNoteGrounds: boolean;
  /** Null for a conversation that isn't a fork. */
  forkOrigin: ForkOrigin | null;
  /** False for an obsolete open; null when the conversation is gone; true when opened. */
  openConversation: (id: number, source: "sidebar" | "restore") => Promise<boolean | null>;
  /**
   * A new chat with the history through a saved message; opens it and returns
   * its id. False when the user left for another chat first; null on failure.
   */
  forkConversation: (throughMessage: Message) => Promise<number | false | null>;
  /** Changes the open conversation's saved messages, while no turn of its own runs. */
  setMessages: (update: (messages: Message[]) => Message[]) => void;
  /** Completes a saved reply in place. */
  saveAssistantMessage: (
    messageId: string,
    content: string,
    toolCalls?: ToolCallInfo[],
    details?: Partial<TurnDetails>
  ) => Promise<void>;
  /** Lets other windows run the conversation again (a restored question settled without a turn). */
  releaseConversation: (id: number) => void;
  newChat: () => void;
  /** False when nothing was sent, another window running the conversation included. */
  send: (text: string, options?: SendToAIOptions) => Promise<boolean>;
  cancel: () => void;
  setDraft: (text: string) => void;
  setSkills: (skills: ChatSkills) => void;
  retryLoad: () => void;
}

function selectionToken(): string {
  return chatSelectionToken(useChatTurnStore.getState());
}

const EMPTY_MESSAGES: Message[] = [];

const hasRestoredQuestion = (messages: Message[]): boolean =>
  messages
    .at(-1)
    ?.toolCalls?.some(
      (call) => call.interaction?.state === "pending" || call.interaction?.state === "interrupted"
    ) ?? false;

// The conversation, and whether this chat may run it: no other window claims it.
async function readConversation(
  id: number
): Promise<{ row: StoredChatConversation | null; owned: boolean } | undefined> {
  const claim = await claimChatConversation(id);
  if (claim) return { row: claim.conversation, owned: claim.owned };
  const row = await window.electronAPI?.getAgentConversation?.(id);
  return row === undefined ? undefined : { row, owned: true };
}

// A saved conversation, keeping the ids of the messages already shown (a card's state is keyed by them).
function withShownIds(row: StoredChatConversation, shown: Message[], recover = true): Message[] {
  return decodeChatMessages(row, recover).map((message) => {
    const existing = shown.find((candidate) => candidate.dbId === message.dbId);
    return existing ? { ...message, id: existing.id } : message;
  });
}

export function useMainChatSession(): MainChatSession {
  const { user } = useAuth();
  // Only what this conversation shows: another turn's chunks must not re-render the whole view.
  const state = useChatTurnStore(
    useShallow((current) => {
      const { selection: selected } = current;
      const openId = selected.kind === "conversation" ? selected.conversationId : null;
      return {
        selection: selected,
        token: chatSelectionToken(current),
        createdSelectionToken: current.createdSelectionToken,
        entry: current.entries[chatSelectionKey(selected)],
        newChatError: current.newChatError,
        draft:
          selected.kind === "new-chat"
            ? current.newChatDraft
            : openId !== null
              ? (current.drafts[openId] ?? "")
              : "",
        storedSkills: openId !== null ? current.conversationSkills[openId] : current.newChatSkills,
      };
    })
  );
  const { selection, token, entry, storedSkills } = state;
  const [loaded, setLoaded] = useState<LoadedSnapshot | null>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const startedLoad = useRef<string | null>(null);
  const loadSource = useRef<"sidebar" | "restore">("restore");
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  // The conversation this view keeps from other windows while its restored question waits.
  const heldConversation = useRef<number | null>(null);
  const releaseConversation = useCallback((id: number): void => {
    if (heldConversation.current === id) heldConversation.current = null;
    releaseChatConversation(id);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
      startedLoad.current = null;
      if (heldConversation.current !== null) releaseConversation(heldConversation.current);
    };
  }, [releaseConversation]);

  const validate = useCallback(
    async (
      id: number,
      source: "sidebar" | "restore",
      { reload = false }: { reload?: boolean } = {}
    ): Promise<boolean | null> => {
      const expectedToken = selectionToken();
      const version = ++requestVersion.current;
      startedLoad.current = expectedToken;
      const current = (): boolean =>
        mounted.current && version === requestVersion.current && selectionToken() === expectedToken;
      try {
        const conversation = await readConversation(id);
        if (!current()) {
          if (conversation?.owned) releaseChatConversation(id);
          return false;
        }
        if (conversation === undefined) throw new Error("Conversation bridge unavailable");
        const { row, owned } = conversation;
        if (row === null) {
          dropChatConversation(id);
          return null;
        }
        if (source === "restore" && row.archived_at) {
          if (owned) releaseChatConversation(id);
          selectChat({ kind: "new-chat" });
          return false;
        }
        acceptChatConversation(id);
        const entry = useChatTurnStore.getState().entries[`conversation:${id}`];
        const saved = entry?.messages ?? decodeChatMessages(row, owned);
        if (owned && !entry && hasRestoredQuestion(saved)) heldConversation.current = id;
        else if (owned) releaseChatConversation(id);
        setLoaded((previous) => ({
          token: expectedToken,
          // A turn that ended while this validated already handed its messages over, ids included.
          messages:
            previous?.token !== expectedToken
              ? saved
              : reload
                ? withShownIds(row, previous.messages, owned)
                : previous.messages,
          error: null,
          noteId: row.note_id ?? null,
          forkOrigin: forkOriginOf(row),
          blocked: !owned,
        }));
        return true;
      } catch {
        if (current())
          setLoaded({
            token: expectedToken,
            messages: [],
            error: i18n.t("chat.conversationLoadFailed"),
            noteId: null,
            forkOrigin: null,
          });
        return false;
      }
    },
    []
  );

  // A conversation another window had is shown again, and can be run here, once it lets go.
  useEffect(
    () =>
      window.electronAPI?.onAgentConversationReleased?.(({ conversationId }) => {
        const selected = useChatTurnStore.getState().selection;
        const shown = loadedRef.current;
        if (
          selected.kind === "conversation" &&
          selected.conversationId === conversationId &&
          shown?.blocked &&
          shown.token === selectionToken()
        )
          void validate(conversationId, loadSource.current, { reload: true });
      }),
    [validate]
  );

  useEffect(() => {
    const held = heldConversation.current;
    if (held !== null && !(selection.kind === "conversation" && selection.conversationId === held))
      releaseConversation(held);
  }, [selection, releaseConversation]);

  useEffect(() => {
    if (selection.kind !== "conversation" || startedLoad.current === token) return;
    void validate(selection.conversationId, loadSource.current);
  }, [selection, token, validate]);

  // A row this store just created still validates, in the background: it has nothing to load.
  const justCreated = state.createdSelectionToken === token && entry !== undefined;
  const validated = selection.kind !== "conversation" || loaded?.token === token || justCreated;
  const error =
    selection.kind === "new-chat"
      ? state.newChatError
      : loaded?.token === token
        ? loaded.error
        : null;
  const ready = validated && !error;
  // Unknown while a conversation validates, so the last chat's note never grounds a send.
  const noteId =
    selection.kind !== "conversation"
      ? null
      : loaded?.token === token
        ? loaded.noteId
        : justCreated
          ? null
          : undefined;
  const source = useSourceNote(noteId);

  const setMessages = useCallback(
    (update: (messages: Message[]) => Message[]): void =>
      setLoaded((previous) =>
        previous?.token === token ? { ...previous, messages: update(previous.messages) } : previous
      ),
    [token]
  );

  useLayoutEffect(() => {
    if (selection.kind !== "conversation" || !ready || !entry || entry.running || entry.settling)
      return;
    // Preserve the original IDs before dropping the unseen entry, so approvals remain attached.
    setLoaded((previous) => ({
      token,
      messages: entry.messages,
      error: null,
      noteId: previous?.token === token ? previous.noteId : null,
      forkOrigin: previous?.token === token ? previous.forkOrigin : null,
    }));
    takeCompletedChatTurn(selection.conversationId, setMessages);
  }, [selection, ready, entry, token, setMessages]);

  const openConversation = useCallback(
    async (id: number, source: "sidebar" | "restore"): Promise<boolean | null> => {
      const current = useChatTurnStore.getState().selection;
      // Reloading the open conversation would blank it and lose an outcome that was never saved.
      if (
        current.kind === "conversation" &&
        current.conversationId === id &&
        startedLoad.current === selectionToken() &&
        !error
      )
        return true;
      loadSource.current = source;
      selectChat({ kind: "conversation", conversationId: id });
      const selectedRevision = useChatTurnStore.getState().selectionRevision;
      const opened = await validate(id, source);
      // A chat the user picks that is gone takes them back to where they were.
      const droppedOnly = useChatTurnStore.getState().selectionRevision === selectedRevision + 1;
      if (opened === null && source === "sidebar" && droppedOnly) {
        if (chatSelectionKey(current) !== `conversation:${id}`) selectChat(current);
      }
      return opened;
    },
    [validate, error]
  );

  const forkConversation = useCallback(
    async (throughMessage: Message): Promise<number | false | null> => {
      const current = useChatTurnStore.getState().selection;
      if (current.kind !== "conversation" || throughMessage.dbId == null) return null;
      const expectedToken = selectionToken();
      let fork;
      try {
        fork = await window.electronAPI?.forkAgentConversation?.(
          current.conversationId,
          throughMessage.dbId,
          null
        );
      } catch {
        return selectionToken() === expectedToken ? null : false;
      }
      if (selectionToken() !== expectedToken) return false;
      if (!fork) return null;
      await openConversation(fork.id, "sidebar");
      return fork.id;
    },
    [openConversation]
  );

  const saveAssistantMessage = useCallback(
    async (
      messageId: string,
      content: string,
      toolCalls?: ToolCallInfo[],
      details: Partial<TurnDetails> = {}
    ): Promise<void> => {
      const conversationId =
        details.conversationId ??
        (selection.kind === "conversation" ? selection.conversationId : null);
      if (conversationId === null) return;
      const rowId = loaded?.messages.find((message) => message.id === messageId)?.dbId;
      const savedId = await saveReplyRow(
        conversationId,
        rowId,
        content,
        replyMetadata(toolCalls, details.turn)
      );
      if (savedId !== null && savedId !== rowId) {
        setMessages((messages) =>
          messages.map((message) =>
            message.id === messageId ? { ...message, dbId: savedId } : message
          )
        );
      }
    },
    [selection, loaded, setMessages]
  );

  const newChat = useCallback((): void => {
    loadSource.current = "sidebar";
    startNewChat();
  }, []);

  const send = useCallback(
    async (text: string, options?: SendToAIOptions): Promise<boolean> => {
      const currentSelection = useChatTurnStore.getState().selection;
      if (
        currentSelection.kind === "conversation" &&
        (loaded?.token !== selectionToken() || loaded.error || source.isLoading)
      )
        return false;
      let messages = currentSelection.kind === "conversation" ? (loaded?.messages ?? []) : [];
      if (currentSelection.kind === "conversation") {
        // Another window running this conversation (or holding its question) keeps it.
        const id = currentSelection.conversationId;
        const expectedToken = selectionToken();
        const claim = await claimChatConversation(id);
        if (selectionToken() !== expectedToken) {
          if (claim?.owned) releaseConversation(id);
          return false;
        }
        if (claim && !claim.owned) return false;
        // Another window may have run it since it loaded here.
        if (
          claim?.conversation &&
          heldConversation.current !== id &&
          !useChatTurnStore.getState().entries[`conversation:${id}`]
        )
          messages = withShownIds(claim.conversation, messages);
      }
      const started = startChatSend({
        selection: currentSelection,
        messages,
        text,
        skills: getChatSkills(currentSelection),
        userName: user?.name ?? null,
        // A skill request starts a new chat and sends in one tick: never carry the last chat's note.
        openNote: currentSelection.kind === "conversation" ? source.openNote : undefined,
        sourceNoteId: currentSelection.kind === "conversation" ? source.sourceNote?.id : undefined,
        sourceNoteSpaceId:
          currentSelection.kind === "conversation" ? source.sourceNote?.spaceId : undefined,
        options,
      });
      if (currentSelection.kind === "conversation") {
        const id = currentSelection.conversationId;
        // The turn holds it now, and gives it back when it ends.
        if (started && heldConversation.current === id) heldConversation.current = null;
        else if (!started && heldConversation.current !== id) releaseConversation(id);
      }
      return started;
    },
    [
      loaded,
      user?.name,
      source.isLoading,
      source.openNote,
      source.sourceNote?.id,
      source.sourceNote?.spaceId,
      releaseConversation,
    ]
  );

  const setSkills = useCallback((next: ChatSkills): void => {
    setChatSkills(useChatTurnStore.getState().selection, next);
  }, []);

  // A conversation with no skills in the store reads them from localStorage.
  const entrySkills = entry?.skills;
  const skills = useMemo(
    () => resolveChatSkills(selection, entrySkills, storedSkills),
    [selection, entrySkills, storedSkills]
  );

  return {
    selection,
    loading: !validated,
    messages: !ready
      ? EMPTY_MESSAGES
      : (entry?.messages ??
        (selection.kind === "conversation"
          ? (loaded?.messages ?? EMPTY_MESSAGES)
          : EMPTY_MESSAGES)),
    agentState: entry?.running
      ? entry.agentState === "idle"
        ? "thinking"
        : entry.agentState
      : "idle",
    toolStatus: entry?.toolStatus ?? "",
    activeToolName: entry?.activeToolName ?? "",
    skills,
    draft: state.draft,
    error,
    sourceNote: source.sourceNote,
    sourceNoteLoading: source.isLoading,
    sourceNoteGrounds: Boolean(source.openNote),
    forkOrigin:
      selection.kind === "conversation" && loaded?.token === token ? loaded.forkOrigin : null,
    openConversation,
    forkConversation,
    setMessages,
    saveAssistantMessage,
    releaseConversation,
    newChat,
    send,
    cancel: () => cancelChatTurn(useChatTurnStore.getState().selection),
    setDraft: (text) => setChatDraft(selection, text),
    setSkills,
    retryLoad: () => {
      if (selection.kind !== "conversation") return;
      setLoaded(null);
      void validate(selection.conversationId, loadSource.current);
    },
  };
}
