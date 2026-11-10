import { splitAtSentenceEnds } from "../utils/splitAtSentenceEnds";

/**
 * A fine-tuned cleanup model is trained on one exact request shape and gets
 * worse on any other. A profile gives such a model its own shape for default
 * dictation cleanup; every model without one keeps the shared cleanup prompt
 * and <transcript> wrapper. To add a model, add an entry to PROFILES.
 */
export interface CleanupPromptProfile {
  systemPrompt: string;
  /** The whole user message for one part of the transcript. */
  buildUserContent: (transcript: string) => string;
  temperature: number;
  /** Longer dictations are cleaned in parts of at most this many words. */
  maxChunkWords: number;
}

export interface CleanupProfileRequest {
  inferenceScope?: string;
  systemPrompt?: string;
  requiresAgent?: boolean;
  hasCustomCleanupPrompt?: boolean;
}

// https://huggingface.co/superwhisper/s1-mini-GGUF. The control line also takes
// Styling casual | semi-casual | formal, Structure lists and Context email;
// Tone & Style could map onto it later. The model is English only and its card
// asks for input over about 1,000 tokens to be split.
const S1_MINI: CleanupPromptProfile = {
  systemPrompt:
    "You are a text normalizer for speech-to-text transcripts. The input begins with a control line specifying the styling, structure, and context settings; clean the transcript to match those settings and output only the cleaned text.",
  buildUserContent: (transcript) =>
    `[Styling: semi-formal] [Structure: prose] [Context: general]\n${transcript}`,
  temperature: 0,
  maxChunkWords: 600,
};

const PROFILES: Record<string, CleanupPromptProfile> = {
  "s1-mini-q4_k_m": S1_MINI,
};

/**
 * The profile for this request, or null to use the shared cleanup prompt. Only
 * default dictation cleanup qualifies: a prompt the caller or the user wrote
 * is sent as written.
 */
export function getCleanupPromptProfile(
  modelId: string | undefined,
  request: CleanupProfileRequest
): CleanupPromptProfile | null {
  if (!modelId || !Object.hasOwn(PROFILES, modelId)) return null;
  if (request.inferenceScope !== "dictationCleanup") return null;
  if (request.systemPrompt || request.requiresAgent || request.hasCustomCleanupPrompt) return null;
  return PROFILES[modelId];
}

/**
 * Cleans the transcript one part at a time, in order, and joins the answers.
 * A part the model returns empty (it was all filler) is left out.
 */
export async function runProfiledCleanup(
  profile: CleanupPromptProfile,
  transcript: string,
  runPart: (userContent: string) => Promise<string>
): Promise<string> {
  const cleaned: string[] = [];
  for (const part of splitAtSentenceEnds(transcript, profile.maxChunkWords)) {
    const output = (await runPart(profile.buildUserContent(part))).trim();
    if (output) cleaned.push(output);
  }
  return cleaned.join(" ");
}
