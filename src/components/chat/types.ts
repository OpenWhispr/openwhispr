export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  status: "executing" | "completed" | "error";
  result?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  isStreaming: boolean;
  toolCalls?: ToolCallInfo[];
}

export type AgentState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "streaming"
  | "tool-executing";

export { toolIcons } from "./toolIcons";
