// Heuristic detector for cleanup output that still looks like a raw transcript.
// The fused Gemini call (STT + cleanup in one request) sometimes returns the
// speech nearly verbatim on long dictations; these checks catch the two
// telltale artifacts a cleaned transcript never keeps.
// ponytail: regex heuristics tuned for Spanish/English dictation; extend the
// filler list if new fillers slip through.
const FILLER_RE =
  /(?:^|[\s(¿¡"'])(?:eh+|ehm+|em+|mm+|uh+|um+|o sea|osea|este(?=\s*,))(?=[\s,.;:!?)"']|$)/giu;
const REPEAT_RE = /\b(\p{L}{2,})(?:\s+\1)+\b/giu;

// One immediate word repetition is already a cleanup failure; a lone filler
// can be a legitimate connective ("o sea que..."), so fillers need two hits.
export function looksUncleaned(text) {
  if (!text || typeof text !== "string") return false;
  const fillers = (text.match(FILLER_RE) || []).length;
  const repeats = (text.match(REPEAT_RE) || []).length;
  return repeats >= 1 || fillers >= 2;
}

const CLEANUP_ESCALATION_MODEL = "gemini-3-flash-preview";

// Returns the stronger sibling model to escalate to, or null when the current
// cleanup model is not a Gemini Lite variant (never escalate non-Lite models).
export function cleanupEscalationModel(model) {
  if (typeof model !== "string") return null;
  return /^gemini-.*lite/i.test(model.trim()) ? CLEANUP_ESCALATION_MODEL : null;
}
