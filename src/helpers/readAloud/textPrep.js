// Turns a raw selection (often Markdown copied from a chat UI) into plain text
// that reads naturally aloud. Pure and synchronous so it can be unit-tested.

const MAX_READ_CHARACTERS = 100_000;

function prepareTextForSpeech(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/\r\n?/g, "\n");

  // Fenced code blocks are noise when listened to.
  text = text.replace(/```[\s\S]*?```/g, " ");
  // Markdown links/images: keep the label, drop the target.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Bare URLs.
  text = text.replace(/\bhttps?:\/\/[^\s)]+/gi, " link ");
  text = text.replace(/\bwww\.[^\s)]+/gi, " link ");
  // Headings, quotes and list markers at line start.
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  text = text.replace(/^\s*>\s?/gm, "");
  text = text.replace(/^\s*[-*+•]\s+/gm, "");
  // Emphasis and inline code markers.
  text = text.replace(/(\*\*|__|\*|_|~~|`)(?=\S)([^\n]*?\S)\1/g, "$2");
  text = text.replace(/`/g, "");
  // Table pipes and horizontal rules.
  text = text.replace(/^\s*[-*_]{3,}\s*$/gm, "");
  text = text.replace(/\|/g, ", ");
  // Emoji and pictographs.
  text = text.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "");

  // A line without closing punctuation still deserves a pause.
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;…,]$/.test(line) ? line : `${line}.`))
    .join("\n");

  text = text.replace(/[ \t]+/g, " ").trim();

  if (text.length > MAX_READ_CHARACTERS) text = text.slice(0, MAX_READ_CHARACTERS);
  return text;
}

const MAX_SENTENCE_CHARACTERS = 300;

// Splits prepared text into the units synthesized one at a time. Knowing the
// boundaries lets playback restart from the current sentence (e.g. after a
// speed change) instead of from the top.
function splitSentences(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const pieces = text
    .split(/\n+|(?<=[.!?…])\s+/)
    .map((piece) => piece.trim())
    .filter(Boolean);

  const sentences = [];
  for (const piece of pieces) {
    let rest = piece;
    while (rest.length > MAX_SENTENCE_CHARACTERS) {
      const window = rest.slice(0, MAX_SENTENCE_CHARACTERS);
      const cut = Math.max(window.lastIndexOf("; "), window.lastIndexOf(", "));
      const at = cut > MAX_SENTENCE_CHARACTERS / 3 ? cut + 1 : window.lastIndexOf(" ");
      const end = at > 0 ? at : MAX_SENTENCE_CHARACTERS;
      sentences.push(rest.slice(0, end).trim());
      rest = rest.slice(end).trim();
    }
    if (!rest) continue;
    // Fold stray fragments ("1." from a numbered list) into the previous one.
    if (rest.length < 4 && sentences.length > 0) {
      sentences[sentences.length - 1] += ` ${rest}`;
    } else {
      sentences.push(rest);
    }
  }
  return sentences;
}

module.exports = {
  prepareTextForSpeech,
  splitSentences,
  MAX_READ_CHARACTERS,
  MAX_SENTENCE_CHARACTERS,
};
