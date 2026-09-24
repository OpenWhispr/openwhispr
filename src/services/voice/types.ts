import type { MutableRefObject } from "react";

/** Lets the voice conversation hear the assistant panel's answer as it streams. */
export interface AssistantSpeechTap {
  onContentDelta: (delta: string) => void;
  onResponseDone: () => void;
  /** The answer is calling tools; speak something so the wait isn't silent. */
  onToolCall: (toolNames: string[]) => void;
  /** Tools offered to the model for this turn (the harness scores against them). */
  onToolsAvailable: (toolNames: string[]) => void;
  /** A write tool finished this turn; `ok` is false when it returned an error. */
  onWriteToolResult: (name: string, ok: boolean) => void;
  /** Harness mode: write tools report success without changing anything. */
  dryRunWrites: boolean;
  /** OPENWHISPR_VOICE_HARNESS_BRAIN: local model that answers voice turns, or null. */
  brainOverride: string | null;
  /** Filled by the panel with its cancel function, so barge-in can stop the answer. */
  cancelRef: MutableRefObject<(() => void) | null>;
}

/** One finished voice turn, sent to the main process in harness mode. */
export interface VoiceTurnReport {
  outcome: string;
  transcript: string;
  calledTools: string[];
  availableTools: string[];
  answer: string;
  metrics: Record<string, number | null>;
}

/** How the worker decided the user's turn was over (Smart Turn or plain silence). */
export interface VoiceTurnEndpoint {
  reason: "silence" | "smart-turn" | "smart-turn-hold" | "max-silence";
  probability: number | null;
  segments: number;
  /** Speech end to turn commit, on the mic clock. */
  endpointMs: number;
  featureMs: number | null;
  inferenceMs: number | null;
}

/** Result of the main-process precondition check run before a session starts. */
export type VoiceConversationReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: "language-unsupported" | "voice-models-missing" | "speech-model-missing" | "brain-not-downloaded";
      missing?: string[];
      missingBytes?: number;
    };

export type VoiceConversationEvent =
  | { type: "speech-start"; at: number }
  | {
      type: "transcript";
      text: string;
      speechMs: number;
      sttMs: number;
      endedAt: number;
      endpoint: VoiceTurnEndpoint | null;
    }
  | { type: "tts-audio"; utteranceId: string; chunkIndex: number; samples: Float32Array; at: number }
  | { type: "error"; stage: string; message: string };
