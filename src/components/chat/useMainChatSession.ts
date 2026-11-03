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
  type ChatSelection,
} from "../../stores/chatTurnStore";
import { decodeChatMessages } from "./chatPersistence";
import type { SendToAIOptions } from "./chatTurnEngine";
import { useSourceNote, type SourceNote } from "./useSourceNote";
import type { ChatSkills } from "./chatSkillMemory";
import type { AgentState, Message } from "./types";

interface LoadedSnapshot {
  token: string;
  messages: Message[];
  error: string | null;
  noteId: number | null;
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
  openConversation: (id: number, source: "sidebar" | "restore") => Promise<void>;
  newChat: () => void;
  send: (text: string, options?: SendToAIOptions) => boolean;
  cancel: () => void;
  setDraft: (text: string) => void;
  setSkills: (skills: ChatSkills) => void;
  retryLoad: () => void;
}

function selectionToken(): string {
  return chatSelectionToken(useChatTurnStore.getState());
}

const EMPTY_MESSAGES: Message[] = [];

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
  const startedLoad = useRef<string | null>(null);
  const loadSource = useRef<"sidebar" | "restore">("restore");
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
      startedLoad.current = null;
    };
  }, []);

  const validate = useCallback(async (id: number, source: "sidebar" | "restore"): Promise<void> => {
    const expectedToken = selectionToken();
    const version = ++requestVersion.current;
    startedLoad.current = expectedToken;
    const current = (): boolean =>
      mounted.current && version === requestVersion.current && selectionToken() === expectedToken;
    try {
      const row = await window.electronAPI?.getAgentConversation?.(id);
      if (!current()) return;
      if (row === undefined) throw new Error("Conversation bridge unavailable");
      if (row === null) {
        dropChatConversation(id);
        return;
      }
      if (source === "restore" && row.archived_at) {
        selectChat({ kind: "new-chat" });
        return;
      }
      acceptChatConversation(id);
      const entry = useChatTurnStore.getState().entries[`conversation:${id}`];
      setLoaded((previous) => ({
        token: expectedToken,
        // A turn that ended while this validated already handed its messages over, ids included.
        messages:
          previous?.token === expectedToken
            ? previous.messages
            : (entry?.messages ?? decodeChatMessages(row)),
        error: null,
        noteId: row.note_id ?? null,
      }));
    } catch {
      if (current())
        setLoaded({
          token: expectedToken,
          messages: [],
          error: i18n.t("chat.conversationLoadFailed"),
          noteId: null,
        });
    }
  }, []);

  useEffect(() => {
    if (selection.kind !== "conversation" || startedLoad.current === token) return;
    void validate(selection.conversationId, loadSource.current);
  }, [selection, token, validate]);

  // A row this store just created still validates, in the background: it has nothing to load.
  const justCreated = state.createdSelectionToken === token;
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

  useLayoutEffect(() => {
    if (selection.kind !== "conversation" || !ready || !entry || entry.running || entry.settling)
      return;
    // Preserve the original IDs before dropping the unseen entry, so approvals remain attached.
    setLoaded((previous) => ({
      token,
      messages: entry.messages,
      error: null,
      noteId: previous?.token === token ? previous.noteId : null,
    }));
    takeCompletedChatTurn(selection.conversationId);
  }, [selection, ready, entry, token]);

  const openConversation = useCallback(
    async (id: number, source: "sidebar" | "restore"): Promise<void> => {
      const current = useChatTurnStore.getState().selection;
      // Reloading the open conversation would blank it and lose an outcome that was never saved.
      if (
        current.kind === "conversation" &&
        current.conversationId === id &&
        startedLoad.current === selectionToken() &&
        !error
      )
        return;
      loadSource.current = source;
      selectChat({ kind: "conversation", conversationId: id });
      await validate(id, source);
    },
    [validate, error]
  );

  const newChat = useCallback((): void => {
    loadSource.current = "sidebar";
    startNewChat();
  }, []);

  const send = useCallback(
    (text: string, options?: SendToAIOptions): boolean => {
      const current = useChatTurnStore.getState();
      const currentSelection = current.selection;
      if (
        currentSelection.kind === "conversation" &&
        (loaded?.token !== selectionToken() || loaded.error || source.isLoading)
      )
        return false;
      return startChatSend({
        selection: currentSelection,
        messages: currentSelection.kind === "conversation" ? (loaded?.messages ?? []) : [],
        text,
        skills: getChatSkills(currentSelection),
        userName: user?.name ?? null,
        // A skill request starts a new chat and sends in one tick: never carry the last chat's note.
        openNote: currentSelection.kind === "conversation" ? source.openNote : undefined,
        sourceNoteId: currentSelection.kind === "conversation" ? source.sourceNote?.id : undefined,
        options,
      });
    },
    [loaded, user?.name, source.isLoading, source.openNote, source.sourceNote?.id]
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
    openConversation,
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
