import type { SETTINGS_TARGETS } from "../helpers/settingsTargets.js";

export type SettingsTarget = (typeof SETTINGS_TARGETS)[number];

/** The model a chat answers with: typed chat's, or the Voice Assistant's. */
export type ChatInferenceScope = "chatIntelligence" | "dictationAgent";

/**
 * What the agent can ask of the user mid-turn. The tool that asks waits for
 * the answer, so the turn resumes where it stopped once the user responds.
 */
export type InteractionQuestionKind = "single" | "multiple" | "text";

export interface InteractionOption {
  id: string;
  label: string;
  /** Shown as the suggested choice; never selected or submitted for the user. */
  recommended?: boolean;
}

export interface InteractionQuestion {
  id: string;
  kind: InteractionQuestionKind;
  prompt: string;
  /** Required for single and multiple choice. */
  options?: InteractionOption[];
  placeholder?: string;
}

/** A connector, a calendar provider, or `calendar` to let the user pick the provider. */
export type ConnectionTarget =
  "gmail" | "slack" | "linear" | "github" | "google" | "microsoft" | "apple" | "calendar";

export type InteractionPayload =
  | { kind: "questions"; questions: InteractionQuestion[] }
  | { kind: "connection"; target: ConnectionTarget; reason?: string }
  | { kind: "access"; resource: "screen"; reason: string }
  | {
      kind: "apiKey";
      provider: string;
      providerName: string;
      reason?: string;
      scope?: ChatInferenceScope;
    }
  | {
      kind: "settings";
      target: SettingsTarget;
      message?: string;
      technicalDetails?: string;
      /** The model scope of the chat that asked, which Done checks for the AI models target. */
      scope?: ChatInferenceScope;
    };

/** Per question: an option id, several option ids, or the typed text. */
export type InteractionAnswers = Record<string, string | string[]>;

/** How an interaction ended. Never carries a secret: a saved key is only `saved`. */
export type InteractionResult =
  | { status: "answered"; answers: InteractionAnswers }
  | { status: "connected"; target: ConnectionTarget }
  | { status: "granted" }
  | { status: "declined" }
  | { status: "saved" }
  | { status: "done"; ready?: boolean }
  | { status: "unavailable"; reason: string }
  | { status: "cancelled" }
  | { status: "not_answered"; reason: "conversation_ended" | "expired" | "duplicate_tool_call" };

/**
 * An interaction as it is saved with its tool call. `interrupted` means the
 * turn that asked it ended without an answer (the app closed or the chat
 * view went away); answering it later starts a new turn.
 */
export interface InteractionRecord {
  payload: InteractionPayload;
  state: "pending" | "settled" | "interrupted";
  result?: InteractionResult;
}
