export type ChatRole = 'user' | 'assistant';
export type ChatStepId = 'calendar' | 'search' | 'read' | 'write';

export interface ChatStep {
  id: ChatStepId;
  status: 'active' | 'done';
  label: string;
  detail?: string;
  /** What a finished step said while it worked, so the status line can still show it in turn. */
  activeLabel?: string;
}

export interface ChatSource {
  noteId: number;
  title: string;
  /** Whether the answer named this note. Saved before this existed, an answer's sources count all. */
  cited?: boolean;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  text: string;
  steps: ChatStep[];
  sources: ChatSource[];
  /** A saved answer whose source list couldn't be read, so which notes it used is unknown. */
  sourcesUnreadable?: boolean;
  createdAt: number;
}

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatConversationSummary extends ChatConversation {
  preview: string;
}

export interface NewChatMessage {
  conversationId: string;
  role: ChatRole;
  text: string;
  steps?: ChatStep[];
  sources?: ChatSource[];
}
