/**
 * Hint-list assembly for STT prompts. Dictionary words arrive most-used
 * first; snippet triggers always go last so tail-keeping decoders never
 * drop them.
 *
 * @param {string[]} dictionaryWords most-used-first dictionary words
 * @param {string[]} triggerWords snippet triggers
 * @param {{ mostUsedLast?: boolean }} [options] flip the dictionary for tail-keeping decoders
 * @returns {string | null} comma-joined prompt, null when empty
 */
export function buildDictionaryPrompt(
  dictionaryWords,
  triggerWords,
  { mostUsedLast = false } = {}
) {
  const dictionary = Array.isArray(dictionaryWords) ? dictionaryWords : [];
  const triggers = Array.isArray(triggerWords) ? triggerWords : [];
  const orderedDictionary = mostUsedLast ? [...dictionary].reverse() : dictionary;
  const words = [...orderedDictionary, ...triggers];
  return words.length > 0 ? words.join(", ") : null;
}

/**
 * Truncate a prompt to maxChars keeping the TAIL, aligned to the next word
 * boundary, because whisper-style decoders keep the final ~224 prompt tokens.
 *
 * @param {string} prompt comma-joined hint list
 * @param {number} maxChars provider character cap
 * @returns {string} the kept tail
 */
export function truncateDictionaryPromptTail(prompt, maxChars) {
  if (typeof prompt !== "string") return prompt;
  if (!Number.isFinite(maxChars) || maxChars <= 0 || prompt.length <= maxChars) return prompt;
  const tail = prompt.slice(-maxChars);
  const firstComma = tail.indexOf(",");
  if (firstComma === -1 || firstComma >= tail.length - 1) return tail;
  const aligned = tail.slice(firstComma + 1).trim();
  return aligned || tail;
}
