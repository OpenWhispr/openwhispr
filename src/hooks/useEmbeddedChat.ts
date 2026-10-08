import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useChatPersistence } from "../components/chat/useChatPersistence";
import { useChatStreaming, type SendToAIOptions } from "../components/chat/useChatStreaming";
import { useChatMessageSender } from "../components/chat/useChatMessageSender";
import type { Message, AgentState } from "../components/chat/types";
import { deriveConversationTitle } from "../lib/conversationTitle";
import { attendeesForUser } from "../utils/noteAttendees";
import type { CalendarAttendee } from "../types/calendar";
import type { NoteAttendeesRequest } from "../types/connectors";

interface UseEmbeddedChatOptions {
  noteId: number | null;
  folderId: number | null;
  noteTitle: string;
  noteContent: string;
  noteTranscript?: string;
  /** The note's participants, as parsed by parseNoteParticipants. */
  noteParticipants?: CalendarAttendee[];
  /**
   * Whether the signed-in user owns the note, which decides what `self`
   * means. Unknown reads as someone else's: then the recorder is listed as
   * an attendee rather than the user left in.
   */
  noteOwnedByUser?: boolean;
  /** The signed-in user's OpenWhispr address, never listed as an attendee. */
  selfEmail?: string | null;
  /** The note's calendar event, whose organizer main adds to the attendees. */
  noteCalendarEventId?: string | null;
  noteSummary?: string;
  /** A message `sendInNewChat` could not send, so the caller can put it back as a draft. */
  onNewChatUnsent?: (text: string) => void;
}

interface NoteConversationItem {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface UseEmbeddedChatReturn {
  messages: Message[];
  agentState: AgentState;
  sendMessage: (text: string, options?: SendToAIOptions) => Promise<void>;
  cancelStream: () => void;
  noteConversations: NoteConversationItem[];
  activeConversationId: number | null;
  switchConversation: (id: number) => Promise<void>;
  startNewChat: () => void;
  /** Starts a new conversation with this message. */
  sendInNewChat: (text: string, options?: SendToAIOptions) => void;
}

// Stable, so a note without participants doesn't rebuild noteMeeting on
// every render.
const NO_PARTICIPANTS: CalendarAttendee[] = [];

export function useEmbeddedChat({
  noteId,
  folderId,
  noteTitle,
  noteContent,
  noteTranscript,
  noteParticipants = NO_PARTICIPANTS,
  noteOwnedByUser = false,
  selfEmail = null,
  noteCalendarEventId = null,
  noteSummary,
  onNewChatUnsent,
}: UseEmbeddedChatOptions): UseEmbeddedChatReturn {
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [noteConversations, setNoteConversations] = useState<NoteConversationItem[]>([]);
  const noteIdRef = useRef(noteId);
  const [prevNoteId, setPrevNoteId] = useState(noteId);

  const persistence = useChatPersistence({
    conversationId,
    onConversationCreated: (id) => {
      setConversationId(id);
    },
  });

  const openNote = useMemo(
    () =>
      [
        `Note ID: ${noteId}`,
        folderId != null ? `Folder ID: ${folderId}` : "",
        `Title: ${noteTitle}`,
        `Content:\n${noteContent}`,
        noteSummary ? `\nAI Summary:\n${noteSummary}` : "",
        noteTranscript ? `\nTranscript:\n${noteTranscript}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    [folderId, noteContent, noteId, noteSummary, noteTitle, noteTranscript]
  );

  const noteMeeting = useMemo<NoteAttendeesRequest>(
    () => ({
      noteId,
      participants: attendeesForUser(noteParticipants, noteOwnedByUser),
      calendarEventId: noteCalendarEventId,
      selfEmail,
    }),
    [noteCalendarEventId, noteId, noteOwnedByUser, noteParticipants, selfEmail]
  );

  // A meeting note's chat drafts follow-ups to its attendees, so it offers
  // the connector tools (still subject to plan, sign-in and policy).
  const streaming = useChatStreaming({
    messages: persistence.messages,
    setMessages: persistence.setMessages,
    openNote,
    allowConnectors: true,
    noteMeeting,
    onStreamComplete: (_id, content, toolCalls) => {
      persistence.saveAssistantMessage(content, toolCalls);
    },
  });

  const fetchNoteConversations = useCallback(async () => {
    if (!noteId) return;
    const conversations = await window.electronAPI?.getConversationsForNote?.(noteId);
    if (noteIdRef.current !== noteId) return;
    setNoteConversations(conversations ?? []);
    return conversations ?? [];
  }, [noteId]);

  if (noteId !== prevNoteId) {
    setPrevNoteId(noteId);
    if (!noteId) {
      persistence.handleNewChat();
      setConversationId(null);
      setNoteConversations([]);
    }
  }

  useEffect(() => {
    noteIdRef.current = noteId;
    if (!noteId) return;

    // The chat opens on a new conversation (see sendInNewChat); earlier ones are in its history.
    persistence.handleNewChat();
    setConversationId(null);
    void fetchNoteConversations();
  }, [noteId]); // eslint-disable-line react-hooks/exhaustive-deps

  // useChatStreaming returns a fresh object every render; cancelStream is
  // stable. Leaving a conversation cancels its turn, as in ChatView: a card
  // waiting for approval would otherwise hold the send lock and save its
  // reply into whichever conversation is open when it settles.
  const { cancelStream } = streaming;

  const switchConversation = useCallback(
    async (id: number) => {
      if (id === conversationId) return;
      cancelStream();
      await persistence.loadConversation(id);
      setConversationId(id);
    },
    [cancelStream, conversationId, persistence]
  );

  const startNewChat = useCallback(() => {
    cancelStream();
    persistence.handleNewChat();
    setConversationId(null);
  }, [cancelStream, persistence]);

  const createConversation = useCallback(
    async (text: string) => {
      const noteName = noteTitle || "Untitled";
      const id = await persistence.createConversation(
        // The message first, so a note's History entries differ; then the note, so the
        // Control Panel's chat list still says which note it's from.
        `${deriveConversationTitle(text, noteName)} · ${noteName}`,
        noteId
      );
      void fetchNoteConversations();
      return id;
    },
    [fetchNoteConversations, noteId, noteTitle, persistence]
  );
  const [submissionInFlight, setSubmissionInFlight] = useState(false);
  const sendMessageWithResult = useChatMessageSender({
    conversationId,
    persistence,
    streaming,
    createConversation,
    onSendingChange: setSubmissionInFlight,
  });
  const sendMessage = useCallback(
    async (text: string, options?: SendToAIOptions): Promise<void> => {
      await sendMessageWithResult(text, options);
    },
    [sendMessageWithResult]
  );

  // The sender reads the conversation of the render it was made in, so a message that
  // starts a new chat waits for the render that cleared the old one.
  const [newChatMessage, setNewChatMessage] = useState<{
    text: string;
    options?: SendToAIOptions;
  } | null>(null);
  const sendInNewChat = useCallback(
    (text: string, options?: SendToAIOptions) => {
      startNewChat();
      setNewChatMessage({ text, options });
    },
    [startNewChat]
  );
  useEffect(() => {
    if (!newChatMessage) return;
    setNewChatMessage(null);
    const { text, options } = newChatMessage;
    // A send that never started (lock held, conversation not created) must not eat the question.
    sendMessageWithResult(text, options).then(
      (sent) => {
        if (!sent) onNewChatUnsent?.(text);
      },
      () => onNewChatUnsent?.(text)
    );
  }, [newChatMessage, onNewChatUnsent, sendMessageWithResult]);

  return {
    messages: persistence.messages,
    // As in ChatView: a cancelled send can hold the submission lock until an in-flight
    // tool returns, and the lock would drop a message sent before then, so the chat
    // reads busy until it lets go.
    agentState:
      submissionInFlight && streaming.agentState === "idle" ? "thinking" : streaming.agentState,
    sendMessage,
    cancelStream: streaming.cancelStream,
    noteConversations,
    activeConversationId: conversationId,
    switchConversation,
    startNewChat,
    sendInNewChat,
  };
}
