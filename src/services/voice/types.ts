import type { MutableRefObject } from "react";

/** Lets the voice conversation hear the assistant panel's answer as it streams. */
export interface AssistantSpeechTap {
  onContentDelta: (delta: string) => void;
  onResponseDone: () => void;
  /** The answer is calling tools; speak something so the wait isn't silent. */
  onToolCall: (toolNames: string[]) => void;
  /** Tools offered to the model for this turn (the harness scores against them). */
  onToolsAvailable: (toolNames: string[]) => void;
  /** Harness mode: write tools report success without changing anything. */
  dryRunWrites: boolean;
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

export type VoiceSpikeEvent =
  | { type: "speech-start"; at: number }
  | { type: "transcript"; text: string; speechMs: number; sttMs: number; endedAt: number }
  | { type: "tts-audio"; utteranceId: string; chunkIndex: number; samples: Float32Array; at: number }
  | { type: "error"; stage: string; message: string };
