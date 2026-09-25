export interface SpeechChunkerOptions {
  /** The first chunk may end at a clause (, ; :) once it is this long, so speech starts sooner. */
  firstChunkMinChars?: number;
  /** A chunk with no boundary is cut at its last space once it grows past this length. */
  maxChunkChars?: number;
  /** The first chunk is cut at a space sooner than that, so the first audio isn't held back. */
  maxFirstChunkChars?: number;
  /** Stop emitting after this many chunks; the rest stays on screen but isn't spoken. */
  maxChunks?: number;
}

export interface SpeechChunker {
  push: (delta: string) => string[];
  flush: () => string[];
  reset: () => void;
}

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…"]);
const CLAUSE_TERMINATORS = new Set([",", ";", ":"]);

const isWhitespace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);
const isLowercase = (char: string | undefined): boolean =>
  char !== undefined && char !== char.toUpperCase() && char === char.toLowerCase();

/** Turns streamed Markdown into text a speech engine can read aloud. */
export function toSpeakableText(text: string): string {
  return text
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/\*+/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-+]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Splits a streamed answer into chunks worth handing to TTS one at a time: whole
 * sentences, except that the first chunk may stop at a clause so the first audio
 * is not held back by a long opening sentence.
 */
export function createSpeechChunker({
  firstChunkMinChars = 24,
  maxChunkChars = 220,
  maxFirstChunkChars = 70,
  maxChunks = Number.POSITIVE_INFINITY,
}: SpeechChunkerOptions = {}): SpeechChunker {
  let buffer = "";
  let emittedAny = false;
  let emittedCount = 0;

  const findBoundary = (): number => {
    for (let index = 0; index < buffer.length; index += 1) {
      const char = buffer[index];
      if (char === "\n") return index;
      const next = buffer[index + 1];
      if (!isWhitespace(next)) continue;
      if (SENTENCE_TERMINATORS.has(char)) {
        const following = buffer.slice(index + 1).trimStart()[0];
        // "e.g. last week" continues the sentence; an uppercase or missing next word ends it.
        if (char === "." && isLowercase(following)) continue;
        return index + 1;
      }
      if (!emittedAny && CLAUSE_TERMINATORS.has(char) && index + 1 >= firstChunkMinChars) {
        return index + 1;
      }
    }
    const limit = emittedAny ? maxChunkChars : maxFirstChunkChars;
    if (buffer.length > limit) {
      const lastSpace = buffer.slice(0, limit + 1).lastIndexOf(" ");
      if (lastSpace > 0) return lastSpace;
    }
    return -1;
  };

  const emit = (raw: string, out: string[]): void => {
    const speakable = toSpeakableText(raw);
    if (!speakable || emittedCount >= maxChunks) return;
    emittedAny = true;
    emittedCount += 1;
    out.push(speakable);
  };

  const drain = (): string[] => {
    const out: string[] = [];
    let boundary = findBoundary();
    while (boundary >= 0) {
      emit(buffer.slice(0, boundary), out);
      buffer = buffer.slice(boundary).replace(/^\s+/, "");
      boundary = findBoundary();
    }
    return out;
  };

  return {
    push(delta) {
      buffer += delta;
      return drain();
    },
    flush() {
      const out = drain();
      emit(buffer, out);
      buffer = "";
      return out;
    },
    reset() {
      buffer = "";
      emittedAny = false;
      emittedCount = 0;
    },
  };
}
