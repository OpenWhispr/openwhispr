import { create } from 'zustand';
import { chatRepository } from '@/data';
import { toChatErrorMessage } from '@/lib/chat/chatErrorMessage';
import { runChatTurn } from '@/lib/chat/runChatTurn';
import type { ChatConversationSummary, ChatMessage, ChatStep } from '@/lib/chat/types';

const TITLE_MAX_LENGTH = 60;

export interface ChatPending {
  // null while transcribing a question for a chat that doesn't exist yet.
  conversationId: string | null;
  phase: 'transcribing' | 'working';
  steps: ChatStep[];
  startedAt: number;
}

export interface ChatFailure {
  conversationId: string;
  messageId: string;
  question: string;
  message: string;
}

export interface ChatSendOptions {
  conversationId: string | null;
  allowCloudFallback: boolean;
}

export interface ChatSendResult {
  conversationId: string;
  done: Promise<void>;
}

interface ChatState {
  conversations: ChatConversationSummary[];
  activeConversationId: string | null;
  messages: ChatMessage[];
  pending: ChatPending | null;
  // Keyed by conversation, so a failure in one chat never takes another's Retry away.
  failures: Record<string, ChatFailure>;
  // Set when a send was refused because a failed chat wipe still holds the saved chats back, so the
  // screens can say why nothing was sent. Cleared once the wipe goes through.
  sendBlockedByWipe: boolean;
  loadConversations: () => void;
  openConversation: (id: string) => void;
  // Clears the open conversation only while it is still `id`, so a screen that's leaving never
  // closes the one opened over it.
  closeConversation: (id: string | null) => void;
  beginTranscribing: (conversationId: string | null) => boolean;
  endTranscribing: () => void;
  send: (question: string, options: ChatSendOptions) => ChatSendResult | null;
  retry: (conversationId: string, options: { allowCloudFallback: boolean }) => Promise<void>;
  editFailedQuestion: (conversationId: string) => string | null;
  cancel: () => void;
  deleteConversation: (id: string) => void;
  reset: () => void;
}

interface TurnRequest {
  conversationId: string;
  userMessageId: string;
  question: string;
  history: ChatMessage[];
  allowCloudFallback: boolean;
}

const INITIAL_STATE: Pick<
  ChatState,
  | 'conversations'
  | 'activeConversationId'
  | 'messages'
  | 'pending'
  | 'failures'
  | 'sendBlockedByWipe'
> = {
  conversations: [],
  activeConversationId: null,
  messages: [],
  pending: null,
  failures: {},
  sendBlockedByWipe: false,
};

const withoutFailure = (
  failures: Record<string, ChatFailure>,
  conversationId: string,
): Record<string, ChatFailure> => {
  if (!(conversationId in failures)) return failures;
  const rest = { ...failures };
  delete rest[conversationId];
  return rest;
};

// One turn runs at a time across every conversation. Bumping the generation orphans whatever is
// in flight, so a result that lands after a cancel, reset or delete never writes anything.
const turn: { controller: AbortController | null; generation: number } = {
  controller: null,
  generation: 0,
};

const abortTurn = (): void => {
  turn.generation += 1;
  turn.controller?.abort();
  turn.controller = null;
};

// A wipe that failed (the chats of an account signed out or switched away from) is finished before
// any chat is read again, and nothing shows while it still fails. The flag is persisted, since the
// next launch reads chats before anything else would retry it. localStorage is expo-sqlite's,
// installed at launch by the database migration; the in-memory copy covers a storage failure.
const WIPE_PENDING_KEY = '@openwhispr:chat_wipe_pending';
let wipePending: boolean | undefined;

const isWipePending = (): boolean => {
  if (wipePending === undefined) {
    try {
      wipePending = localStorage.getItem(WIPE_PENDING_KEY) !== null;
    } catch {
      wipePending = false;
    }
  }
  return wipePending;
};

const setWipePending = (pending: boolean): void => {
  wipePending = pending;
  try {
    if (pending) localStorage.setItem(WIPE_PENDING_KEY, '1');
    else localStorage.removeItem(WIPE_PENDING_KEY);
  } catch {
    // The in-memory flag still holds the chats back for this session.
  }
};

/** Deletes every saved chat. Throws when it fails, and the wipe is retried before the next read. */
export const wipeSavedChats = (): void => {
  setWipePending(true);
  chatRepository.clearAll();
  setWipePending(false);
};

const savedChatsReadable = (): boolean => {
  if (!isWipePending()) return true;
  try {
    wipeSavedChats();
    return true;
  } catch {
    return false;
  }
};

const readConversations = (): ChatConversationSummary[] =>
  savedChatsReadable() ? chatRepository.listConversations() : [];

const readMessages = (conversationId: string): ChatMessage[] =>
  savedChatsReadable() ? chatRepository.getMessages(conversationId) : [];

const toConversationTitle = (question: string): string => {
  const collapsed = question.replace(/\s+/g, ' ').trim();
  // Counted by code point, so the cut never splits an emoji's surrogate pair.
  const characters = Array.from(collapsed);
  return characters.length > TITLE_MAX_LENGTH
    ? `${characters.slice(0, TITLE_MAX_LENGTH).join('')}…`
    : collapsed;
};

export const useChatStore = create<ChatState>((set, get) => {
  const runTurn = async (request: TurnRequest): Promise<void> => {
    const controller = new AbortController();
    turn.generation += 1;
    turn.controller = controller;
    const generation = turn.generation;
    const isCurrent = (): boolean => generation === turn.generation;

    set({
      pending: {
        conversationId: request.conversationId,
        phase: 'working',
        steps: [],
        startedAt: Date.now(),
      },
    });

    try {
      const result = await runChatTurn({
        question: request.question,
        history: request.history,
        signal: controller.signal,
        allowCloudFallback: request.allowCloudFallback,
        onSteps: (steps) => {
          if (!isCurrent()) return;
          set((state) => (state.pending ? { pending: { ...state.pending, steps } } : {}));
        },
      });
      if (!isCurrent()) return;
      turn.controller = null;
      const saved = chatRepository.appendMessage({
        conversationId: request.conversationId,
        role: 'assistant',
        text: result.text,
        steps: result.steps,
        sources: result.sources,
      });
      set((state) => ({
        pending: null,
        conversations: readConversations(),
        messages:
          state.activeConversationId === request.conversationId
            ? [...state.messages, saved]
            : state.messages,
      }));
    } catch (error) {
      if (!isCurrent()) return;
      // Cancel and reset already orphaned their turn, so anything reaching here, an AbortError
      // included, is a real failure the user can retry.
      turn.controller = null;
      set((state) => ({
        pending: null,
        failures: {
          ...state.failures,
          [request.conversationId]: {
            conversationId: request.conversationId,
            messageId: request.userMessageId,
            question: request.question,
            message: toChatErrorMessage(error),
          },
        },
      }));
    }
  };

  return {
    ...INITIAL_STATE,

    loadConversations: () => {
      const conversations = readConversations();
      set(isWipePending() ? { conversations } : { conversations, sendBlockedByWipe: false });
    },

    openConversation: (id) => {
      set({ activeConversationId: id, messages: readMessages(id) });
    },

    closeConversation: (id) => {
      if (get().activeConversationId === id) set({ activeConversationId: null, messages: [] });
    },

    beginTranscribing: (conversationId) => {
      if (get().pending) return false;
      set({ pending: { conversationId, phase: 'transcribing', steps: [], startedAt: Date.now() } });
      return true;
    },

    endTranscribing: () => {
      if (get().pending?.phase === 'transcribing') set({ pending: null });
    },

    send: (question, options) => {
      // Only this send's own refusal may say so: callers read the flag after any null.
      set({ sendBlockedByWipe: false });
      const text = question.trim();
      // A spoken question's own slot is released before it sends, so any pending entry is a turn or
      // a transcription this send would race.
      if (!text || get().pending) return null;
      // Nothing is written beside chats a failed wipe still holds back.
      if (!savedChatsReadable()) {
        set({ sendBlockedByWipe: true });
        return null;
      }
      // A screen can still hold the id of a conversation deleted under it.
      if (options.conversationId && !chatRepository.getConversation(options.conversationId)) {
        return null;
      }

      const conversationId =
        options.conversationId ?? chatRepository.createConversation(toConversationTitle(text)).id;
      const history = readMessages(conversationId);
      const userMessage = chatRepository.appendMessage({ conversationId, role: 'user', text });
      set((state) => ({
        failures: withoutFailure(state.failures, conversationId),
        conversations: readConversations(),
        messages:
          state.activeConversationId === conversationId
            ? [...state.messages, userMessage]
            : state.messages,
      }));

      const done = runTurn({
        conversationId,
        userMessageId: userMessage.id,
        question: text,
        history,
        allowCloudFallback: options.allowCloudFallback,
      });
      return { conversationId, done };
    },

    retry: async (conversationId, { allowCloudFallback }) => {
      const { failures, pending } = get();
      const failure = failures[conversationId];
      if (!failure || pending) return;

      const stored = readMessages(conversationId);
      const index = stored.findIndex((message) => message.id === failure.messageId);
      set((state) => ({ failures: withoutFailure(state.failures, conversationId) }));
      if (index === -1) return;

      await runTurn({
        conversationId: failure.conversationId,
        userMessageId: failure.messageId,
        question: failure.question,
        history: stored.slice(0, index),
        allowCloudFallback,
      });
    },

    editFailedQuestion: (conversationId) => {
      const failure = get().failures[conversationId];
      if (!failure) return null;

      chatRepository.deleteMessage(failure.messageId);
      // A conversation left with nothing in it would linger as an empty row under the old title, so
      // it goes, and the next send starts a new one titled from the edited question.
      const emptied = chatRepository.getMessages(failure.conversationId).length === 0;
      if (emptied) chatRepository.deleteConversation(failure.conversationId);
      set((state) => ({
        failures: withoutFailure(state.failures, conversationId),
        conversations: readConversations(),
        ...(emptied && state.activeConversationId === failure.conversationId
          ? { activeConversationId: null, messages: [] }
          : { messages: state.messages.filter((message) => message.id !== failure.messageId) }),
      }));
      return failure.question;
    },

    cancel: () => {
      abortTurn();
      set({ pending: null });
    },

    deleteConversation: (id) => {
      if (get().pending?.conversationId === id) get().cancel();
      chatRepository.deleteConversation(id);
      set((state) => ({
        conversations: readConversations(),
        failures: withoutFailure(state.failures, id),
        ...(state.activeConversationId === id ? { activeConversationId: null, messages: [] } : {}),
      }));
    },

    reset: () => {
      abortTurn();
      set(INITIAL_STATE);
    },
  };
});
