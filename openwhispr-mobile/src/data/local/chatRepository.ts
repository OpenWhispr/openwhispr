import { asc, desc, eq, sql } from 'drizzle-orm';
import { chatConversations, chatMessages } from '@/db/schema';
import { randomUUID } from '@/lib/uuid';
import type {
  ChatConversation,
  ChatConversationSummary,
  ChatMessage,
  ChatRole,
  ChatSource,
  ChatStep,
  NewChatMessage,
} from '@/lib/chat/types';

type ChatDb = typeof import('@/db').db;
type ConversationRow = typeof chatConversations.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

const PREVIEW_MAX_LENGTH = 120;

const getDefaultDb = (): ChatDb => {
  const { db } = require('@/db') as typeof import('@/db');
  return db;
};

// A corrupt or NULL column must never hide the message itself, so it reads as null and the
// message shows with an empty list.
const parseJsonArray = <T>(raw: string | null): T[] | null => {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
};

// Answers are markdown, so the one-line preview drops its markers rather than showing "**Decision:**".
// Only paired or line-leading markers go, so "5 * 3", "__init__.py" and URLs read as written.
const toPreview = (text: string | null): string =>
  (text ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Table separator rows and horizontal rules.
    .replace(/^\s*\|?\s*:?-{3,}[-|:\s]*$/gm, '')
    .replace(/^\s*\|.*$/gm, (row) => row.replace(/\|/g, ' '))
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_MAX_LENGTH);

const toConversation = (row: ConversationRow): ChatConversation => ({
  id: row.id,
  title: row.title,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toMessage = (row: MessageRow): ChatMessage => {
  const sources = parseJsonArray<ChatSource>(row.sourcesJson);
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as ChatRole,
    text: row.text,
    steps: parseJsonArray<ChatStep>(row.stepsJson) ?? [],
    sources: sources ?? [],
    // Every saved answer records its sources, so one that can't be read fails closed.
    ...(sources === null && row.role === 'assistant' ? { sourcesUnreadable: true } : {}),
    createdAt: row.createdAt,
  };
};

export class LocalChatRepository {
  private readonly database: ChatDb;

  constructor(database?: ChatDb) {
    this.database = database ?? getDefaultDb();
  }

  listConversations(limit?: number): ChatConversationSummary[] {
    // The latest message is read in the same query, so the list costs one query, not one per chat.
    // Drizzle leaves a column unqualified here, so the outer id is named with its table.
    const lastText = sql<string | null>`(
      SELECT ${chatMessages.text} FROM ${chatMessages}
      WHERE ${chatMessages.conversationId} = ${chatConversations}.${sql.identifier(chatConversations.id.name)}
      ORDER BY ${chatMessages.createdAt} DESC, ${chatMessages}.rowid DESC
      LIMIT 1
    )`;
    const query = this.database
      .select({ conversation: chatConversations, lastText })
      .from(chatConversations)
      .orderBy(desc(chatConversations.updatedAt), desc(sql`${chatConversations}.rowid`));
    const rows = limit === undefined ? query.all() : query.limit(limit).all();

    return rows.map((row) => ({
      ...toConversation(row.conversation),
      preview: toPreview(row.lastText),
    }));
  }

  getConversation(id: string): ChatConversation | null {
    const row = this.database
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.id, id))
      .get();
    return row ? toConversation(row) : null;
  }

  createConversation(title: string): ChatConversation {
    const now = Date.now();
    const conversation: ChatConversation = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
    };
    this.database.insert(chatConversations).values(conversation).run();
    return conversation;
  }

  getMessages(conversationId: string): ChatMessage[] {
    return this.database
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(asc(chatMessages.createdAt), asc(sql`${chatMessages}.rowid`))
      .all()
      .map(toMessage);
  }

  appendMessage(input: NewChatMessage): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      text: input.text,
      steps: input.steps ?? [],
      sources: input.sources ?? [],
      createdAt: Date.now(),
    };
    this.database.transaction((tx) => {
      tx.insert(chatMessages)
        .values({
          id: message.id,
          conversationId: message.conversationId,
          role: message.role,
          text: message.text,
          stepsJson: JSON.stringify(message.steps),
          sourcesJson: JSON.stringify(message.sources),
          createdAt: message.createdAt,
        })
        .run();
      tx.update(chatConversations)
        .set({ updatedAt: message.createdAt })
        .where(eq(chatConversations.id, message.conversationId))
        .run();
    });
    return message;
  }

  deleteMessage(id: string): void {
    this.database.delete(chatMessages).where(eq(chatMessages.id, id)).run();
  }

  deleteConversation(id: string): void {
    // Messages go first so this never depends on SQLite foreign keys being enabled.
    this.database.transaction((tx) => {
      tx.delete(chatMessages).where(eq(chatMessages.conversationId, id)).run();
      tx.delete(chatConversations).where(eq(chatConversations.id, id)).run();
    });
  }

  clearAll(): void {
    this.database.transaction((tx) => {
      tx.delete(chatMessages).run();
      tx.delete(chatConversations).run();
    });
  }
}
