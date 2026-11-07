/** What a call hears and answers in; "auto" answers in the language spoken. */
export type VoiceCallLanguage = "auto" | "en" | "hi" | "es" | "fr" | "de";

/** The call's voices by their setting ids (main maps them to Supertonic speakers). */
export type VoiceCallVoice = "helios" | "aurora";

/** What one utterance is spoken with: every chunk of it carries the same profile. */
export interface VoiceSpeechProfile {
  voice: VoiceCallVoice;
  speed: number;
  /** A language Supertonic reads (never "auto"). */
  language: string;
}

/** One finished voice turn, sent to the main process in harness mode. */
export interface VoiceTurnReport {
  outcome: string;
  transcript: string;
  calledTools: string[];
  availableTools: string[];
  /** Write tools actually executed (not blocked as a repeat by the guard); see TurnMetrics.ranWrites. */
  ranWrites: string[];
  answer: string;
  /** When the turn's speech ended (main-process clock), so a late report can't be misfiled. */
  endedAt: number;
  metrics: Record<string, number | null>;
}

/** How the worker decided the user's turn was over (Smart Turn or plain silence). */
export interface VoiceTurnEndpoint {
  reason: "silence" | "smart-turn" | "max-silence" | "max-turn";
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
      reason:
        | "language-unsupported"
        | "voice-models-missing"
        | "speech-model-missing"
        | "language-model-missing"
        | "brain-not-downloaded"
        | "brain-sign-in-required"
        | "meeting-recording"
        | "brain-key-missing";
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
  | {
      type: "tts-audio";
      utteranceId: string;
      chunkIndex: number;
      samples: Float32Array;
      at: number;
    }
  | { type: "error"; stage: "stt" | "worker"; message: string }
  | { type: "ended"; reason: "meeting" };
