export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  status: "executing" | "completed" | "error";
  result?: string;
  // Single object for note tools; search_notes attaches its result array.
  metadata?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  isStreaming: boolean;
  toolCalls?: ToolCallInfo[];
}

export type AgentState =
  "idle" | "listening" | "transcribing" | "thinking" | "streaming" | "tool-executing";

/** Screenshot riding along with a voice command (base64 without a data-URL prefix). */
export interface ChatImageAttachment {
  image: string;
  mediaType: string;
}

export { toolIcons } from "./toolIcons";
