import type { TechnicalErrorDetailsData } from "../ui/useToast";
import type { ProviderSettingsTarget } from "../../utils/describeProviderError";
import type { InteractionRecord } from "../../types/agentInteractions";

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: string;
  /** stopped: still running when its turn ended (Stop, a switch, an error). */
  status: "executing" | "completed" | "error" | "stopped";
  result?: string;
  /** Set when the call ran but didn't do what was asked; result then says why. */
  failed?: boolean;
  // Single object for note tools; search_notes attaches its result array.
  metadata?: Record<string, unknown> | Array<Record<string, unknown>>;
  /** Epoch milliseconds. */
  startedAt?: number;
  finishedAt?: number;
  /** What this call asked of the user (ask_user, request_connection, …). */
  interaction?: InteractionRecord;
  /** Set on a send that happened (or may have), so the conversation never repeats it. */
  actionKey?: string;
}

export interface MessageError {
  technicalDetails?: TechnicalErrorDetailsData;
  settingsTarget?: ProviderSettingsTarget;
}

/**
 * Where an assistant turn is. `running` while it streams; `waiting` while it
 * is paused on the user's answer; `interrupted` when that wait ended without
 * an answer (the app closed or the chat went away); `step_limit` when it
 * stopped at the tool-step cap with work left.
 */
export type AssistantTurnStatus =
  "running" | "complete" | "stopped" | "error" | "waiting" | "interrupted" | "step_limit";

export interface AssistantTurn {
  /** Epoch milliseconds. */
  startedAt: number;
  finishedAt?: number;
  status: AssistantTurnStatus;
  /** The model's reasoning, where the provider streams it. */
  reasoning?: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  isStreaming: boolean;
  toolCalls?: ToolCallInfo[];
  /** Set on a failed reply; transient (not part of the saved conversation). */
  error?: MessageError;
  /** The saved row, once there is one; forks run through it. */
  dbId?: number;
  /** Assistant messages: timing, outcome and reasoning. */
  turn?: AssistantTurn;
  /** User messages: the selected text the request was about. */
  selectedContext?: string;
}

export type AgentState =
  "idle" | "listening" | "transcribing" | "thinking" | "streaming" | "tool-executing";

/** Screenshot riding along with a voice command (base64 without a data-URL prefix). */
export interface ChatImageAttachment {
  image: string;
  mediaType: string;
}

export { toolIcons } from "./toolIcons";
