const MAX_TITLE_LENGTH = 40;

// Titles space/folder chats by their first user message so the conversation
// picker doesn't list N entries all named after the container.
export function deriveConversationTitle(text: string, fallback: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return fallback;
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_TITLE_LENGTH).trimEnd()}…`;
}
