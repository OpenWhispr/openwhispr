import { create } from "zustand";
import i18n from "../i18n";
import type {
  ChatTurnEngine,
  ChatTurnOptions,
  SendToAIOptions,
} from "../components/chat/chatTurnEngine";
import { appendChatMessage } from "../components/chat/chatPersistence";
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
  options?: SendToAIOptions;
}

interface ChatTurnState {
  entries: Record<string, ChatTurnEntry>;
  selection: ChatSelection;
  selectionRevision: number;
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
const deletedConversations = new Set<number>();
const conversationRevisions = new Map<number, number>();
let accountId: string | null | undefined;

export function chatSelectionKey(selection: ChatSelection): string {
  if (selection.kind === "conversation") return `conversation:${selection.conversationId}`;
  if (selection.kind === "submission") return `submission:${selection.submissionId}`;
  return "new-chat";
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
    newChatDraft: state.newChatError ? state.newChatDraft : "",
    newChatError: state.newChatError,
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

export function getChatSkills(selection: ChatSelection): ChatSkills {
  const state = useChatTurnStore.getState();
  const entry = state.entries[chatSelectionKey(selection)];
  if (entry) return entry.skills;
  if (selection.kind === "conversation")
    return (
      state.conversationSkills[selection.conversationId] ?? readChatSkills(selection.conversationId)
    );
  return state.newChatSkills;
}

function bumpListRevision(): void {
  useChatTurnStore.setState((state) => ({ listRevision: state.listRevision + 1 }));
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
  const entry: ChatTurnEntry = {
    submissionId,
    conversationId,
    accountGeneration: state.accountGeneration,
    messages: [
      ...(state.entries[selectionKey]?.messages ?? input.messages),
      {
        id: crypto.randomUUID(),
        role: "user",
        content: input.text,
        isStreaming: false,
      },
    ],
    agentState: "thinking",
    toolStatus: "",
    activeToolName: "",
    running: true,
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
    ...(conversationId === null
      ? { newChatDraft: "", newChatError: null, newChatSkills: NO_CHAT_SKILLS }
      : { drafts: { ...state.drafts, [conversationId]: "" } }),
  });
  const ownerCurrent = (): boolean =>
    useChatTurnStore.getState().accountGeneration === operation.generation &&
    (operation.conversationId === null ||
      (!deletedConversations.has(operation.conversationId) &&
        (conversationRevisions.get(operation.conversationId) ?? 0) === conversationRevision));
  const active = (): boolean => ownerCurrent() && !operation.cancelled;
  const patch = (update: (current: ChatTurnEntry) => Partial<ChatTurnEntry>): void => {
    if (!active()) return;
    useChatTurnStore.setState((current) => {
      const target = current.entries[operation.key];
      if (target?.submissionId !== submissionId) return current;
      return { entries: { ...current.entries, [operation.key]: { ...target, ...update(target) } } };
    });
  };
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
    try {
      if (operation.conversationId === null) {
        const title = input.text.length > 50 ? `${input.text.slice(0, 50)}...` : input.text;
        const row = await window.electronAPI?.createAgentConversation?.(title);
        if (!active()) return;
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
              ? { selection: { kind: "conversation" as const, conversationId: row.id } }
              : {}),
          };
        });
        writeChatSkills(row.id, input.skills);
      }
      const boundId = operation.conversationId;
      if (!active()) return;
      await appendChatMessage(boundId, "user", input.text);
      if (!active()) return;
      bumpListRevision();
      const { createChatTurnEngine } = await import("../components/chat/chatTurnEngine");
      if (!active()) return;
      operation.engine = createChatTurnEngine(
        () => ({
          userName: input.userName,
          openNote: input.openNote,
          allowConnectors: true,
          skillsEnabled: true,
          isOwnerCurrent: ownerCurrent,
        }),
        {
          setMessages: (update) => patch((current) => ({ messages: update(current.messages) })),
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
        persistAssistantMessage: (content, toolCalls) => {
          // An already-saved skill may report after Stop. Account changes and deletion fence even that write.
          if (!ownerCurrent()) return;
          const write = appendChatMessage(boundId, "assistant", content, toolCalls)
            .then(() => {
              if (ownerCurrent()) bumpListRevision();
            })
            .catch(() => {
              showSaveError();
            });
          writes.push(write);
          return write;
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
            newChatDraft: [current.newChatDraft, input.text].filter(Boolean).join("\n\n"),
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
      patch(() => ({ running: false, agentState: "idle", toolStatus: "", activeToolName: "" }));
      submissions.delete(submissionId);
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
    if (entry.conversationId === null) delete entries[key];
    else
      entries[key] = {
        ...entry,
        running: false,
        agentState: "idle",
        toolStatus: "",
        activeToolName: "",
        messages: entry.messages.filter((message) => !message.isStreaming),
      };
    const selectedSubmission =
      entry.conversationId === null && chatSelectionKey(state.selection) === key;
    return {
      entries,
      ...(selectedSubmission
        ? {
            selection: { kind: "new-chat" as const },
            selectionRevision: state.selectionRevision + 1,
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

export function takeCompletedChatTurn(conversationId: number): ChatTurnEntry | null {
  const key = `conversation:${conversationId}`;
  const entry = useChatTurnStore.getState().entries[key];
  if (!entry || entry.running) return null;
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

export function subscribeChatPolicy(): () => void {
  const enforce = (): void => {
    if (!isAgentAllowed(usePolicyStore.getState())) cancelAllChatTurns();
  };
  enforce();
  return usePolicyStore.subscribe(enforce);
}
