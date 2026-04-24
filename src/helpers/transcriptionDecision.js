import { detectAgentName } from "../utils/agentNameDetection.js";

/**
 * Decides whether a transcription should be processed through the LLM,
 * based on the current toggle states and transcript content.
 *
 * @param {object} opts
 * @param {boolean} opts.useReasoningModel - "Text Cleanup" toggle
 * @param {boolean} opts.agentEnabled      - "AI Agent" toggle
 * @param {string|null} opts.agentName     - configured agent name (nullable)
 * @param {string} opts.transcript         - the transcribed text
 * @returns {"process"|"agent-only"|"skip"}
 */
export function shouldProcessTranscription({
  useReasoningModel,
  agentEnabled,
  agentName,
  transcript,
}) {
  // Both off: nothing to do
  if (!useReasoningModel && !agentEnabled) return "skip";

  // Cleanup on: always process (prompt selection handles agent detection)
  if (useReasoningModel) return "process";

  // Agent-only (cleanup off, agent on): process only when addressed
  if (!agentName || !detectAgentName(transcript, agentName)) return "skip";
  return "agent-only";
}
