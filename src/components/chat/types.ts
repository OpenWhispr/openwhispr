import type { TechnicalErrorDetailsData } from "../ui/useToast";
import type { ProviderSettingsTarget } from "../../utils/describeProviderError";

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  status: "executing" | "completed" | "error";
  result?: string;
  // Single object for note tools; search_notes attaches its result array.
  metadata?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export interface MessageError {
  technicalDetails?: TechnicalErrorDetailsData;
  settingsTarget?: ProviderSettingsTarget;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  isStreaming: boolean;
  toolCalls?: ToolCallInfo[];
  /** Set on a failed reply; transient (not part of the saved conversation). */
  error?: MessageError;
}

export type AgentState =
  "idle" | "listening" | "transcribing" | "thinking" | "streaming" | "tool-executing";

/** Screenshot riding along with a voice command (base64 without a data-URL prefix). */
export interface ChatImageAttachment {
  image: string;
  mediaType: string;
}

export { toolIcons } from "./toolIcons";
