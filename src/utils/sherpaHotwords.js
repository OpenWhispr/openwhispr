// Dictionary words reach sherpa-onnx transducers as hotwords: during
// modified_beam_search every token that continues a dictionary word earns a
// bonus (#3117). The bonus is measured per model, on speech with and without
// dictionary words: past it the decoder writes dictionary words into speech
// that has none. Orukeet fixed names at 2-3 on a short list, cut sentences at
// 4, and inserted names at 3 once the list reached ~270 words. Other models
// decode without the dictionary until measured (Parakeet Unified ignored a
// bonus of 3 and collapsed at 8).
const HOTWORDS_SCORES = { "orukeet-v0.1.0": 2 };

// Every extra word is one more chance to resemble ordinary speech.
export const MAX_SHERPA_HOTWORDS = 100;

export function getSherpaHotwordsScore(modelName) {
  return Object.hasOwn(HOTWORDS_SCORES, modelName) ? HOTWORDS_SCORES[modelName] : null;
}

// One hotword per line, highest priority first. sherpa reads a word starting
// with ":" as that line's own score, and aborts at startup when it is not a
// number ("smile :)"), so such words are dropped.
export function buildSherpaHotwords(dictionary) {
  const seen = new Set();
  const hotwords = [];
  for (const entry of dictionary) {
    if (typeof entry !== "string") continue;
    for (const term of entry.split(/[,\r\n]+/)) {
      const hotword = term
        .split(/\s+/)
        .filter((word) => word && !word.startsWith(":"))
        .join(" ");
      const key = hotword.toLowerCase();
      if (!hotword || seen.has(key)) continue;
      seen.add(key);
      hotwords.push(hotword);
      if (hotwords.length === MAX_SHERPA_HOTWORDS) return hotwords;
    }
  }
  return hotwords;
}
