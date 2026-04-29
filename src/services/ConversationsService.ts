import { cloudGet, cloudPost, cloudPatch, cloudDelete } from "./cloudApi.js";

interface ConversationInput {
  client_conversation_id?: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  messages?: Array<{
    role: "user" | "assistant" | "system";
    content: string;
    metadata?: Record<string, unknown> | null;
  }>;
}

interface CloudConversation {
  id: string;
  client_conversation_id: string | null;
  title: string;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CloudMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface CloudConversationWithMessages extends CloudConversation {
  messages?: CloudMessage[];
}

async function create(input: ConversationInput): Promise<CloudConversation> {
  return cloudPost<CloudConversation>("/api/conversations/create", input);
}

async function update(
  id: string,
  updates: { title?: string; archived_at?: string }
): Promise<CloudConversation> {
  return cloudPatch<CloudConversation>("/api/conversations/update", { id, ...updates });
}

async function deleteConversation(id: string): Promise<void> {
  await cloudDelete("/api/conversations/delete", { id });
}

async function list(
  limit?: number,
  before?: string,
  archived?: boolean,
  include?: string,
  since?: string
): Promise<{ conversations: CloudConversationWithMessages[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (before !== undefined) params.set("before", before);
  if (archived) params.set("archived", "true");
  if (include !== undefined) params.set("include", include);
  if (since !== undefined) params.set("since", since);
  const query = params.toString();
  return cloudGet<{ conversations: CloudConversationWithMessages[] }>(
    `/api/conversations/list${query ? `?${query}` : ""}`
  );
}

async function addMessage(
  conversationId: string,
  role: "user" | "assistant" | "system",
  content: string,
  metadata?: Record<string, unknown> | null
): Promise<CloudMessage> {
  return cloudPost<CloudMessage>("/api/conversations/messages", {
    conversation_id: conversationId,
    role,
    content,
    ...(metadata ? { metadata } : {}),
  });
}

async function listMessages(conversationId: string): Promise<{ messages: CloudMessage[] }> {
  const params = new URLSearchParams({ conversation_id: conversationId });
  return cloudGet<{ messages: CloudMessage[] }>(`/api/conversations/messages?${params}`);
}

async function search(
  query: string,
  limit?: number
): Promise<{ conversations: CloudConversation[] }> {
  return cloudPost<{ conversations: CloudConversation[] }>("/api/conversations/search", {
    query,
    ...(limit !== undefined ? { limit } : {}),
  });
}

export { create, update, deleteConversation, list, addMessage, listMessages, search };

export const ConversationsService = {
  create,
  update,
  delete: deleteConversation,
  list,
  addMessage,
  listMessages,
  search,
};
