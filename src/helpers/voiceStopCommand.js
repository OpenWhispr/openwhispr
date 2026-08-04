/**
 * Utility for stripping a configured voice stop command (wake word) from the end of a transcript.
 * This allows users to say a command like "Jarvis done" to stop dictating without having it appear
 * in their final text.
 */

/**
 * Strips the stopPhrase from the end of the text, ignoring case and trailing punctuation.
 *
 * @param {string} text The full transcribed text
 * @param {string} stopPhrase The configured phrase to remove (e.g. "Jarvis done")
 * @returns {string} The cleaned text
 */
function stripVoiceStopCommand(text, stopPhrase) {
  if (!text || typeof text !== "string") return text || "";
  if (!stopPhrase || typeof stopPhrase !== "string") return text;

  const phrase = stopPhrase.trim();
  if (!phrase) return text;

  // Escape regex specials
  const escapedPhrase = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Matches the phrase exactly as whole words at the end of the string,
  // optionally followed by punctuation (.,!?) and whitespace.
  // We use \b to ensure word boundaries.
  const regex = new RegExp(`\\b${escapedPhrase}[.!?,\\s]*$`, "i");

  if (regex.test(text)) {
    const replaced = text.replace(regex, "");
    return replaced.trimEnd();
  }

  return text;
}

module.exports = {
  stripVoiceStopCommand,
};
