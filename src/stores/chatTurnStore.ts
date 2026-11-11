import { create } from "zustand";
import i18n from "../i18n";
import type {
  ChatTurnEngine,
  ChatTurnOptions,
  OpenNoteContext,
  SendToAIOptions,
} from "../components/chat/chatTurnEngine";
import { appendChatMessage, replyMetadata, saveReplyRow } from "../components/chat/chatPersistence";
import {
  NO_CHAT_SKILLS,
  readChatSkills,
  writeChatSkills,
  forgetChatSkills,
  type ChatSkills,
} from "../components/chat/chatSkillMemory";
import type { AgentState, Message } from "../components/chat/types";
import { usePolicyStore } from "./policyStore";
import { isAgentAllowed } from "./policyRules";
import { normalizeAgentSelectionContext } from "../utils/agentSelectionContext";

export type ChatSelection =
  | { kind: "new-chat" }
  | { kind: "submission"; submissionId: string }
  | { kind: "conversation"; conversationId: number };

export interface ChatTurnEntry {
  submissionId: string;
  conversationId: number | null;
  accountGeneration: number;
  messages: Message[];
  agentState: AgentState;
  toolStatus: string;
  activeToolName: string;
  running: boolean;
  /** Stopped, but a tool that had already gone out may still report its result. */
  settling: boolean;
  skills: ChatSkills;
}

export interface StartChatSendInput {
  selection: ChatSelection;
  messages: Message[];
  text: string;
  skills: ChatSkills;
  userName: string | null;
  /** The note this conversation was started from, bound for this turn. */
  openNote?: ChatTurnOptions["openNote"];
  sourceNoteId?: number;
  options?: SendToAIOptions;
}

interface ChatTurnState {
  entries: Record<string, ChatTurnEntry>;
  selection: ChatSelection;
  selectionRevision: number;
  /** The selection this store just created its row for, so it needn't blank while validating. */
  createdSelectionToken: string | null;
  accountGeneration: number;
  listRevision: number;
  drafts: Record<number, string>;
  newChatDraft: string;
  newChatError: string | null;
  newChatSkills: ChatSkills;
  conversationSkills: Record<number, ChatSkills>;
}

export const useChatTurnStore = create<ChatTurnState>(() => ({
  entries: {},
  selection: { kind: "new-chat" },
  selectionRevision: 0,
  createdSelectionToken: null,
  accountGeneration: 0,
  listRevision: 0,
  drafts: {},
  newChatDraft: "",
  newChatError: null,
  newChatSkills: NO_CHAT_SKILLS,
  conversationSkills: {},
}));

interface Submission {
  key: string;
  generation: number;
  conversationId: number | null;
  cancelled: boolean;
  engine: ChatTurnEngine | null;
}
const submissions = new Map<string, Submission>();
type MessagesUpdate = (messages: Message[]) => Message[];
// The chat that took each conversation's finished turn: a send that commits after Stop still
// reports on the message that chat now shows.
const handedOverTurns = new Map<
  number,
  { submissionId: string; setMessages: (update: MessagesUpdate) => void }
>();
const deletedConversations = new Set<number>();
const conversationRevisions = new Map<number, number>();
let accountId: string | null | undefined;
// This chat's claim on a conversation in main: while one of its turns runs there (or a
// question it restored waits), another window shows the conversation without running or
// answering it.
const chatOwnerId = crypto.randomUUID();

export function claimChatConversation(id: number) {
  return window.electronAPI?.claimAgentConversation?.(id, chatOwnerId);
}

/** Gives the conversation back to other windows, unless one of this chat's turns still runs there. */
export function releaseChatConversation(id: number): void {
  const entry = useChatTurnStore.getState().entries[`conversation:${id}`];
  if (entry?.running || entry?.settling) return;
  void window.electronAPI?.releaseAgentConversation?.(id, chatOwnerId);
}

export function chatSelectionKey(selection: ChatSelection): string {
  if (selection.kind === "conversation") return `conversation:${selection.conversationId}`;
  if (selection.kind === "submission") return `submission:${selection.submissionId}`;
  return "new-chat";
}

export function chatSelectionToken(state: ChatTurnState): string {
  return `${state.accountGeneration}:${state.selectionRevision}:${chatSelectionKey(state.selection)}`;
}

export function selectChat(selection: ChatSelection): void {
  useChatTurnStore.setState((state) => ({
    selection,
    selectionRevision: state.selectionRevision + 1,
  }));
}

export function startNewChat(): void {
  useChatTurnStore.setState((state) => ({
    selection: { kind: "new-chat" },
    selectionRevision: state.selectionRevision + 1,
    newChatSkills: NO_CHAT_SKILLS,
  }));
}

export function setChatDraft(selection: ChatSelection, text: string): void {
  if (selection.kind === "submission") return;
  useChatTurnStore.setState((state) =>
    selection.kind === "new-chat"
      ? { newChatDraft: text, newChatError: null }
      : { drafts: { ...state.drafts, [selection.conversationId]: text } }
  );
}

export function returnChatDraft(selection: ChatSelection, text: string): void {
  const { newChatDraft, drafts } = useChatTurnStore.getState();
  const draft =
    selection.kind === "conversation" ? (drafts[selection.conversationId] ?? "") : newChatDraft;
  setChatDraft(selection, withQuestionReturned(draft, text));
}

export function setChatSkills(selection: ChatSelection, skills: ChatSkills): void {
  if (selection.kind === "new-chat") {
    useChatTurnStore.setState({ newChatSkills: skills });
    return;
  }
  if (selection.kind === "conversation") writeChatSkills(selection.conversationId, skills);
  useChatTurnStore.setState((state) => {
    const key = chatSelectionKey(selection);
    const entry = state.entries[key];
    return {
      ...(entry ? { entries: { ...state.entries, [key]: { ...entry, skills } } } : {}),
      ...(selection.kind === "conversation"
        ? {
            conversationSkills: { ...state.conversationSkills, [selection.conversationId]: skills },
          }
        : {}),
    };
  });
}

export function resolveChatSkills(
  selection: ChatSelection,
  entrySkills: ChatSkills | undefined,
  storedSkills: ChatSkills | undefined
): ChatSkills {
  if (entrySkills) return entrySkills;
  if (selection.kind === "conversation")
    return storedSkills ?? readChatSkills(selection.conversationId);
  return storedSkills ?? NO_CHAT_SKILLS;
}

export function getChatSkills(selection: ChatSelection): ChatSkills {
  const state = useChatTurnStore.getState();
  return resolveChatSkills(
    selection,
    state.entries[chatSelectionKey(selection)]?.skills,
    selection.kind === "conversation"
      ? state.conversationSkills[selection.conversationId]
      : state.newChatSkills
  );
}

function bumpListRevision(): void {
  useChatTurnStore.setState((state) => ({ listRevision: state.listRevision + 1 }));
}

function withQuestionReturned(newChatDraft: string, question: string): string {
  return [newChatDraft, question].filter(Boolean).join("\n\n");
}

// A row whose send was stopped before it could hold anything would otherwise stay as an empty chat.
function removeAbandonedConversation(id: number, generation: number): void {
  void Promise.resolve(window.electronAPI?.deleteAgentConversation?.(id))
    .catch(() => {})
    .then(() => {
      if (useChatTurnStore.getState().accountGeneration === generation) bumpListRevision();
    });
}

export function startChatSend(input: StartChatSendInput): boolean {
  const state = useChatTurnStore.getState();
  const selectionKey = chatSelectionKey(input.selection);
  if (
    !input.text.trim() ||
    selectionKey !== chatSelectionKey(state.selection) ||
    input.selection.kind === "submission" ||
    state.entries[selectionKey]?.running ||
    !isAgentAllowed(usePolicyStore.getState())
  )
    return false;
  const submissionId = crypto.randomUUID();
  const conversationId =
    input.selection.kind === "conversation" ? input.selection.conversationId : null;
  if (conversationId !== null && deletedConversations.has(conversationId)) return false;
  const conversationRevision =
    conversationId === null ? 0 : (conversationRevisions.get(conversationId) ?? 0);
  const selection: ChatSelection =
    conversationId === null ? { kind: "submission", submissionId } : input.selection;
  const key = chatSelectionKey(selection);
  const selectedContext = normalizeAgentSelectionContext(input.options?.selectedContext)?.text;
  const userMessageId = crypto.randomUUID();
  const entry: ChatTurnEntry = {
    submissionId,
    conversationId,
    accountGeneration: state.accountGeneration,
    messages: [
      ...(state.entries[selectionKey]?.messages ?? input.messages),
      {
        id: userMessageId,
        role: "user",
        content: input.text,
        isStreaming: false,
        ...(selectedContext ? { selectedContext } : {}),
      },
    ],
    agentState: "thinking",
    toolStatus: "",
    activeToolName: "",
    running: true,
    settling: false,
    skills: input.skills,
  };
  const operation: Submission = {
    key,
    generation: state.accountGeneration,
    conversationId,
    cancelled: false,
    engine: null,
  };
  submissions.set(submissionId, operation);
  useChatTurnStore.setState({
    entries: { ...state.entries, [key]: entry },
    selection,
    selectionRevision: state.selectionRevision + (conversationId === null ? 1 : 0),
    // Not the draft: the composer clears what it sends, and a starter card or skill draft isn't it.
    ...(conversationId === null ? { newChatError: null, newChatSkills: NO_CHAT_SKILLS } : {}),
  });
  const ownerCurrent = (): boolean =>
    useChatTurnStore.getState().accountGeneration === operation.generation &&
    (operation.conversationId === null ||
      (!deletedConversations.has(operation.conversationId) &&
        (conversationRevisions.get(operation.conversationId) ?? 0) === conversationRevision));
  const active = (): boolean => ownerCurrent() && !operation.cancelled;
  const patchEntry = (
    allowed: () => boolean,
    update: (current: ChatTurnEntry) => Partial<ChatTurnEntry>
  ): void => {
    if (!allowed()) return;
    useChatTurnStore.setState((current) => {
      const target = current.entries[operation.key];
      if (target?.submissionId !== submissionId) return current;
      return { entries: { ...current.entries, [operation.key]: { ...target, ...update(target) } } };
    });
  };
  const patch = (update: (current: ChatTurnEntry) => Partial<ChatTurnEntry>): void =>
    patchEntry(active, update);
  // Stop only fences the turn's status: what it did still belongs on its message.
  const setMessages = (update: MessagesUpdate): void => {
    if (!ownerCurrent()) return;
    const view =
      operation.conversationId === null ? undefined : handedOverTurns.get(operation.conversationId);
    if (view?.submissionId === submissionId) view.setMessages(update);
    else patchEntry(ownerCurrent, (current) => ({ messages: update(current.messages) }));
  };
  // The saved row a message forks through.
  const setDbId = (messageId: string, dbId: number): void =>
    setMessages((messages) =>
      messages.map((message) => (message.id === messageId ? { ...message, dbId } : message))
    );
  const showSaveError = (): void =>
    patch((current) => ({
      messages: [
        ...current.messages.map((message) => ({ ...message, isStreaming: false })),
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: i18n.t("chat.messageSaveFailed"),
          isStreaming: false,
        },
      ],
    }));
  const run = async (): Promise<void> => {
    const writes: Promise<void>[] = [];
    // One save at a time per reply, so a reply saved while it waited is
    // completed in place rather than added twice.
    const savedRows = new Map<string, Promise<number | null>>();
    const openNote = input.openNote;
    let noteAvailable = true;
    const invalidateNote = (): void => {
      noteAvailable = false;
    };
    const invalidateChangedNote = (note: { id: number }): void => {
      if (note.id === input.sourceNoteId) invalidateNote();
    };
    // Note changes and container revocation must reach this send after its source-note hook unmounts.
    const noteDisposers = openNote
      ? [
          window.electronAPI?.onNoteUpdated?.(invalidateChangedNote),
          window.electronAPI?.onNoteSynced?.(invalidateChangedNote),
          window.electronAPI?.onNoteDeleted?.(invalidateChangedNote),
          window.electronAPI?.onSpacePurged?.(invalidateNote),
          window.electronAPI?.onFolderDeleted?.(invalidateNote),
        ]
      : [];
    let claimedId: number | null = null;
    try {
      if (operation.conversationId === null) {
        const title = input.text.length > 50 ? `${input.text.slice(0, 50)}...` : input.text;
        const row = await window.electronAPI?.createAgentConversation?.(title);
        if (!active()) {
          if (row) removeAbandonedConversation(row.id, operation.generation);
          return;
        }
        if (!row) throw new Error("Conversation creation failed");
        operation.conversationId = row.id;
        const previousKey = operation.key;
        operation.key = `conversation:${row.id}`;
        useChatTurnStore.setState((current) => {
          const entries = { ...current.entries };
          const pending = entries[previousKey];
          delete entries[previousKey];
          entries[operation.key] = { ...pending, conversationId: row.id };
          const stillSelected =
            current.selection.kind === "submission" &&
            current.selection.submissionId === submissionId;
          return {
            entries,
            listRevision: current.listRevision + 1,
            ...(stillSelected
              ? {
                  selection: { kind: "conversation" as const, conversationId: row.id },
                  createdSelectionToken: `${current.accountGeneration}:${current.selectionRevision}:${operation.key}`,
                }
              : {}),
          };
        });
        writeChatSkills(row.id, input.skills);
      }
      const boundId = operation.conversationId;
      if (!active()) return;
      const claim = await claimChatConversation(boundId);
      if (claim?.owned) claimedId = boundId;
      if (!active()) return;
      if (claim && !claim.owned) throw new Error("Another window is running this conversation");
      const userRowId = await appendChatMessage(
        boundId,
        "user",
        input.text,
        selectedContext ? { selectedContext } : undefined
      );
      if (!active()) return;
      setDbId(userMessageId, userRowId);
      bumpListRevision();
      const { createChatTurnEngine } = await import("../components/chat/chatTurnEngine");
      if (!active()) return;
      operation.engine = createChatTurnEngine(
        () => ({
          userName: input.userName,
          openNote: openNote
            ? (maxTranscriptTokens): OpenNoteContext => {
                if (!noteAvailable) return { text: "", transcriptPreview: false };
                return typeof openNote === "function"
                  ? openNote(maxTranscriptTokens)
                  : { text: openNote, transcriptPreview: false };
              }
            : undefined,
          allowConnectors: true,
          allowInteractions: true,
          skillsEnabled: true,
          isOwnerCurrent: ownerCurrent,
        }),
        {
          setMessages,
          setAgentState: (agentState) => patch(() => ({ agentState })),
          setToolStatus: (toolStatus) => patch(() => ({ toolStatus })),
          setActiveToolName: (activeToolName) => patch(() => ({ activeToolName })),
        }
      );
      await operation.engine.send(input.text, entry.messages, {
        ...input.options,
        attachedSkill: input.options?.attachedSkill ?? input.skills.attached?.ref,
        allowSkillPick: input.options?.allowSkillPick ?? !input.skills.pickOff,
        removedSkills: input.options?.removedSkills ?? input.skills.removed,
        onSkillPicked: (skill) => {
          if (!active()) return;
          const ownSelection: ChatSelection = { kind: "conversation", conversationId: boundId };
          setChatSkills(ownSelection, {
            ...getChatSkills(ownSelection),
            attached: { ref: { name: skill.name }, displayName: skill.displayName, picked: true },
          });
        },
        persistAssistantMessage: (messageId, content, toolCalls, { turn }) => {
          // An already-saved skill may report after Stop. Account changes and deletion fence even that write.
          if (!ownerCurrent()) return;
          const metadata = replyMetadata(toolCalls, turn);
          const saving = (savedRows.get(messageId) ?? Promise.resolve(null)).then(async (rowId) => {
            const savedId = await saveReplyRow(boundId, rowId, content, metadata);
            if (savedId === null) throw new Error("Conversation is no longer available");
            return savedId;
          });
          savedRows.set(
            messageId,
            saving.catch(() => null)
          );
          const write = saving
            .then((rowId) => {
              setDbId(messageId, rowId);
              if (ownerCurrent()) bumpListRevision();
            })
            .catch(() => {
              showSaveError();
            });
          writes.push(write);
        },
      });
      await Promise.all(writes);
    } catch {
      if (!active()) return;
      if (operation.conversationId === null) {
        useChatTurnStore.setState((current) => {
          const entries = { ...current.entries };
          delete entries[operation.key];
          const stillSelected = chatSelectionKey(current.selection) === operation.key;
          return {
            entries,
            newChatDraft: withQuestionReturned(current.newChatDraft, input.text),
            newChatError: i18n.t("chat.conversationCreateFailed"),
            ...(stillSelected
              ? {
                  selection: { kind: "new-chat" as const },
                  newChatSkills: input.skills,
                  selectionRevision: current.selectionRevision + 1,
                }
              : {}),
          };
        });
      } else showSaveError();
    } finally {
      noteDisposers.forEach((dispose) => dispose?.());
      patch(() => ({ running: false, agentState: "idle", toolStatus: "", activeToolName: "" }));
      patchEntry(ownerCurrent, () => ({ settling: false }));
      submissions.delete(submissionId);
      // Even for a dropped chat: a delete that fails keeps its row, which must not stay busy.
      if (claimedId !== null) releaseChatConversation(claimedId);
    }
  };
  void run();
  return true;
}

export function cancelChatTurn(selection: ChatSelection): void {
  const key = chatSelectionKey(selection);
  const entry = useChatTurnStore.getState().entries[key];
  if (!entry?.running) return;
  const operation = submissions.get(entry.submissionId);
  if (operation) {
    operation.cancelled = true;
    operation.engine?.cancel({ explicit: true });
  }
  useChatTurnStore.setState((state) => {
    const entries = { ...state.entries };
    const current = entries[key] ?? entry;
    if (entry.conversationId === null) delete entries[key];
    else
      entries[key] = {
        ...current,
        running: false,
        settling: Boolean(operation),
        agentState: "idle",
        toolStatus: "",
        activeToolName: "",
        // Stop keeps the reply (saved when its turn started) with what its tools already did; the engine saves it as stopped.
        messages: current.messages.map((message) => ({ ...message, isStreaming: false })),
      };
    if (entry.conversationId !== null) return { entries };
    const selected = chatSelectionKey(state.selection) === key;
    return {
      entries,
      newChatDraft: withQuestionReturned(state.newChatDraft, entry.messages.at(-1)?.content ?? ""),
      ...(selected
        ? {
            selection: { kind: "new-chat" as const },
            selectionRevision: state.selectionRevision + 1,
            newChatSkills: entry.skills,
          }
        : {}),
    };
  });
}

export function dropChatConversation(conversationId: number): void {
  deletedConversations.add(conversationId);
  conversationRevisions.set(conversationId, (conversationRevisions.get(conversationId) ?? 0) + 1);
  cancelChatTurn({ kind: "conversation", conversationId });
  forgetChatSkills(conversationId);
  useChatTurnStore.setState((state) => {
    const entries = { ...state.entries },
      drafts = { ...state.drafts },
      conversationSkills = { ...state.conversationSkills };
    delete entries[`conversation:${conversationId}`];
    delete drafts[conversationId];
    delete conversationSkills[conversationId];
    const selected =
      state.selection.kind === "conversation" && state.selection.conversationId === conversationId;
    return {
      entries,
      drafts,
      conversationSkills,
      listRevision: state.listRevision + 1,
      ...(selected
        ? {
            selection: { kind: "new-chat" as const },
            selectionRevision: state.selectionRevision + 1,
          }
        : {}),
    };
  });
}

// A failed delete can leave a real row. Validation permits new turns without reviving old owners.
export function acceptChatConversation(conversationId: number): void {
  deletedConversations.delete(conversationId);
}

export function takeCompletedChatTurn(
  conversationId: number,
  setMessages: (update: MessagesUpdate) => void
): ChatTurnEntry | null {
  const key = `conversation:${conversationId}`;
  const entry = useChatTurnStore.getState().entries[key];
  if (!entry || entry.running || entry.settling) return null;
  handedOverTurns.set(conversationId, { submissionId: entry.submissionId, setMessages });
  useChatTurnStore.setState((state) => {
    const entries = { ...state.entries };
    delete entries[key];
    return { entries };
  });
  return entry;
}

export function cancelAllChatTurns(): void {
  for (const entry of Object.values(useChatTurnStore.getState().entries)) {
    cancelChatTurn(
      entry.conversationId === null
        ? { kind: "submission", submissionId: entry.submissionId }
        : { kind: "conversation", conversationId: entry.conversationId }
    );
  }
}

export function resetForAccountChange(): void {
  const state = useChatTurnStore.getState();
  // Fence callbacks before aborting: abort listeners can run synchronously.
  useChatTurnStore.setState({
    entries: {},
    drafts: {},
    newChatDraft: "",
    newChatError: null,
    newChatSkills: NO_CHAT_SKILLS,
    conversationSkills: {},
    selection: { kind: "new-chat" },
    selectionRevision: state.selectionRevision + 1,
    accountGeneration: state.accountGeneration + 1,
    listRevision: state.listRevision + 1,
  });
  for (const operation of submissions.values()) {
    operation.cancelled = true;
    operation.engine?.cancel({ explicit: true });
  }
  submissions.clear();
  handedOverTurns.clear();
  deletedConversations.clear();
  conversationRevisions.clear();
}

export function prepareChatAccountScope(userId: string | null): void {
  if (accountId !== undefined && accountId !== userId) resetForAccountChange();
  accountId = userId;
}

export function useIsConversationAnswering(conversationId: number): boolean {
  return useChatTurnStore(
    (state) => state.entries[`conversation:${conversationId}`]?.running ?? false
  );
}

// Main can clear the scope on its own (the token going away), with no session answer to follow.
export function subscribeChatAccountScope(): () => void {
  void Promise.resolve(window.electronAPI?.getActiveAccountScope?.()).then((scope) => {
    if (accountId === undefined && scope) accountId = scope.accountId;
  });
  return (
    window.electronAPI?.onActiveAccountScopeChanged?.((scope) =>
      prepareChatAccountScope(scope?.accountId ?? null)
    ) ?? ((): void => {})
  );
}

export function subscribeChatPolicy(): () => void {
  const enforce = (): void => {
    if (!isAgentAllowed(usePolicyStore.getState())) cancelAllChatTurns();
  };
  enforce();
  return usePolicyStore.subscribe(enforce);
}
