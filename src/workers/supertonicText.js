// Supertonic 3's text front end: the clean-up, chunking and character ids its models expect.
// Follows Supertonic's sample code (MIT, Copyright 2025 Supertone Inc.) and sherpa-onnx's port
// of it (Apache-2.0, Copyright 2026 zengyw), so a sentence reads the same as it did there.

const REPLACEMENTS = [
  ["–", "-"],
  ["‑", "-"],
  ["—", "-"],
  ["_", " "],
  ["“", '"'],
  ["”", '"'],
  ["‘", "'"],
  ["’", "'"],
  ["´", "'"],
  ["`", "'"],
  ["[", " "],
  ["]", " "],
  ["|", " "],
  ["/", " "],
  ["#", " "],
  ["→", " "],
  ["←", " "],
  ["♥", ""],
  ["☆", ""],
  ["♡", ""],
  ["©", ""],
  ["\\", ""],
  ["@", " at "],
  ["e.g.,", "for example, "],
  ["i.e.,", "that is, "],
];

const ENDS_A_SENTENCE = /[.!?;:,'")\]}>…。」』】〉》›»]$/u;
const SENTENCE_BOUNDARY = new Set([".", "!", "?", "。", "！", "？"]);
const CHUNK_BOUNDARY = new Set([...SENTENCE_BOUNDARY, ",", ";", ":", "，", "；", "："]);

const isSpace = (char) => /^[ \t\n\v\f\r]$/.test(char);
const trim = (text) => text.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");

function isCjk(char) {
  const code = char.codePointAt(0);
  return (
    (code >= 0x1100 && code <= 0x11ff) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xa840 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff65 && code <= 0xffdc) ||
    (code >= 0x20000 && code <= 0x2ffff)
  );
}

/** The text as the model reads it, wrapped in its language tags. */
function preprocessText(text, lang) {
  let result = text;
  for (const [from, to] of REPLACEMENTS) result = result.split(from).join(to);
  result = result
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, "")
    .replace(/ ([,.!?;:'])/g, "$1")
    .replace(/""|''/g, (pair) => pair[0])
    .replace(/[ \t\n\v\f\r]+/g, " ");
  result = trim(result);
  if (result && !ENDS_A_SENTENCE.test(result)) result += ".";
  return `<${lang}>${result}</${lang}>`;
}

/** Character ids for one chunk: each character decomposed, then looked up in the indexer. */
function textToIds(text, lang, indexer) {
  const ids = [];
  for (const char of preprocessText(text, lang)) {
    // The indexer covers the Basic Multilingual Plane; anything beyond it is dropped.
    if (char.codePointAt(0) > 0xffff) continue;
    for (const part of char.normalize("NFKD")) {
      const code = part.codePointAt(0);
      ids.push(code < indexer.length ? indexer[code] : 0);
    }
  }
  return ids;
}

function splitParagraphs(text) {
  const paragraphs = [];
  let current = "";
  const flush = () => {
    const paragraph = trim(current);
    if (paragraph) paragraphs.push(paragraph);
    current = "";
  };
  for (const rawLine of text.split("\n")) {
    const line = trim(rawLine);
    if (!line) flush();
    else current += (current ? " " : "") + line;
  }
  flush();
  return paragraphs;
}

function splitSentences(text) {
  const sentences = [];
  let current = "";
  const flush = () => {
    const sentence = trim(current);
    if (sentence) sentences.push(sentence);
    current = "";
  };
  for (const char of text) {
    current += char;
    if (SENTENCE_BOUNDARY.has(char)) flush();
  }
  flush();
  return sentences;
}

/** Cuts a sentence over the limit at its last space or punctuation before the limit. */
function splitLongSentence(sentence, maxChars) {
  const chars = Array.from(trim(sentence));
  const pieces = [];
  const push = (from, to) => {
    const piece = trim(chars.slice(from, to).join(""));
    if (piece) pieces.push(piece);
  };
  let start = 0;
  while (start < chars.length) {
    const end = Math.min(start + maxChars, chars.length);
    if (end >= chars.length) {
      push(start, chars.length);
      break;
    }
    let splitAt = end;
    for (let index = end; index > start; index -= 1) {
      const char = chars[index - 1];
      if (isSpace(char)) {
        splitAt = index - 1;
        break;
      }
      if (CHUNK_BOUNDARY.has(char)) {
        splitAt = index;
        break;
      }
    }
    if (splitAt <= start) splitAt = end;
    push(start, splitAt);
    start = splitAt;
    while (start < chars.length && isSpace(chars[start])) start += 1;
  }
  return pieces;
}

function needsSpaceBetween(left, right) {
  const last = Array.from(left).at(-1);
  const first = Array.from(right)[0];
  if (isSpace(last) || isSpace(first)) return false;
  return !(isCjk(last) || isCjk(first) || CHUNK_BOUNDARY.has(last) || CHUNK_BOUNDARY.has(first));
}

/** Packs whole sentences into chunks the model can read in one go. */
function chunkText(text, maxChars) {
  const whole = trim(text);
  if (!whole) return [];
  const chunks = [];
  let current = "";
  const flush = () => {
    const chunk = trim(current);
    if (chunk) chunks.push(chunk);
    current = "";
  };
  for (const paragraph of splitParagraphs(whole)) {
    for (const sentence of splitSentences(paragraph)) {
      for (const piece of splitLongSentence(sentence, maxChars)) {
        if (!current) {
          current = piece;
          continue;
        }
        const joiner = needsSpaceBetween(current, piece) ? " " : "";
        if (Array.from(current).length + joiner.length + Array.from(piece).length <= maxChars) {
          current += joiner + piece;
        } else {
          flush();
          current = piece;
        }
      }
    }
  }
  flush();
  return chunks;
}

module.exports = { chunkText, preprocessText, textToIds };
