const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Clamps free-typed emoji-field input to a single emoji. A plain `maxLength`
// counts UTF-16 code units, which silently rejects ZWJ sequences like 🧑‍💻 (5
// units) — segmenting by grapheme keeps every emoji intact. The last grapheme
// wins so typing into a filled field replaces the current emoji.
export function clampEmojiInput(value: string): string {
  let last = "";
  for (const { segment } of graphemeSegmenter.segment(value.trim())) {
    last = segment;
  }
  return last;
}
