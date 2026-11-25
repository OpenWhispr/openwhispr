// ElevenLabs Scribe answers silence with this text instead of an empty string,
// on its own API and through OpenRouter. ESM so dictation (renderer) and main
// (via require(esm)) read the same marker.
export const SCRIBE_SILENCE_MARKER = "[pause]";
