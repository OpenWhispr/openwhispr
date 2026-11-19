// Drops the segments a cloud Whisper decoder itself would have skipped as
// silence, so a quiet stretch it filled with training-data boilerplate ("Thank
// you for watching!", "Sous-titres par…", #462) isn't pasted. Reads the
// verbose_json `segments` that OpenAI whisper-1 and Groq return.
//
// The rule and thresholds are Whisper's own no-speech check (openai/whisper
// transcribe.py, defaults no_speech_threshold=0.6, logprob_threshold=-1.0):
// skip when no_speech_prob > 0.6, unless avg_logprob > -1.0 says the decoder
// was confident in the words anyway. Both signals are required, so quiet real
// speech, which keeps a good logprob, stays.
const NO_SPEECH_THRESHOLD = 0.6;
const LOGPROB_THRESHOLD = -1.0;

const isNoSpeechSegment = (segment) =>
  Number.isFinite(segment?.no_speech_prob) &&
  Number.isFinite(segment?.avg_logprob) &&
  segment.no_speech_prob > NO_SPEECH_THRESHOLD &&
  segment.avg_logprob <= LOGPROB_THRESHOLD;

// Returns the transcript without no-speech segments, or the response's text
// unchanged when there is nothing to drop or the segments can't be trusted to
// rebuild it (they must hold every character of the text, whitespace aside).
export function dropNoSpeechSegments(result) {
  const text = result?.text;
  const segments = result?.segments;
  if (typeof text !== "string" || !Array.isArray(segments) || !segments.length) return text;
  if (!segments.some(isNoSpeechSegment)) return text;

  // Segment strings can omit spaces or normalize paragraphs. Match their
  // non-whitespace characters in order, but copy kept spans from the original.
  const originalCharacters = /\S/gu;
  const kept = [];
  for (const segment of segments) {
    if (typeof segment?.text !== "string") return text;
    const start = originalCharacters.lastIndex;
    for (const character of segment.text.replace(/\s/g, "")) {
      if (originalCharacters.exec(text)?.[0] !== character) return text;
    }
    if (!isNoSpeechSegment(segment)) kept.push(text.slice(start, originalCharacters.lastIndex));
  }
  if (originalCharacters.test(text)) return text;
  return kept.join("").trim();
}
