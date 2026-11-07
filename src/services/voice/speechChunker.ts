export interface SpeechChunker {
  push: (delta: string) => string[];
  flush: () => string[];
  reset: () => void;
}

// "।" ends a Hindi sentence.
const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…", "।"]);
const CLAUSE_TERMINATORS = new Set([",", ";", ":"]);
// The first chunk may end at a clause this far in, so a long opening sentence's audio starts sooner.
const FIRST_CHUNK_MIN_CHARS = 24;

const isWhitespace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);
const isLowercase = (char: string | undefined): boolean =>
  char !== undefined && char !== char.toUpperCase() && char === char.toLowerCase();

/** Turns streamed Markdown into text a speech engine can read aloud. */
export function toSpeakableText(text: string): string {
  return (
    text
      .replace(/^\s*([-*_])\1{2,}\s*$/gm, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "a link")
      .replace(/`([^`]*)`/g, "$1")
      // A line that is only bold, with no sentence end ("**Inner Planets**"), is a heading.
      .replace(/^\s*(\*\*|__)[^*_\n]*[^*_.!?…।\s]\1\s*$/gm, "")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/\*+/g, "")
      // A heading is structure, not something to say.
      .replace(/^\s{0,3}#{1,6}\s.*$/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*(?:[-+•]|\d+[.)])\s+/gm, "")
      // "Settings → Profile" is read as a pause between the two.
      .replace(/\s*(?:→|⟶|➔|⇒|->|=>)\s*/g, ", ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Splits a streamed answer into chunks worth handing to TTS one at a time: whole
 * sentences (or lines); only the first chunk may stop at a clause.
 */
export function createSpeechChunker(): SpeechChunker {
  let buffer = "";
  let emittedCount = 0;

  const findBoundary = (): number => {
    for (let index = 0; index < buffer.length; index += 1) {
      const char = buffer[index];
      if (char === "\n") return index;
      const next = buffer[index + 1];
      if (!isWhitespace(next)) continue;
      if (SENTENCE_TERMINATORS.has(char)) {
        const following = buffer.slice(index + 1).trimStart()[0];
        // "e.g. last week" continues the sentence, and so does a list item's number
        // ("1. Keep"); an uppercase or missing next word ends it.
        if (char === "." && (isLowercase(following) || /^\d+$/.test(buffer.slice(0, index)))) {
          continue;
        }
        return index + 1;
      }
      if (
        emittedCount === 0 &&
        CLAUSE_TERMINATORS.has(char) &&
        index + 1 >= FIRST_CHUNK_MIN_CHARS
      ) {
        return index + 1;
      }
    }
    return -1;
  };

  const emit = (raw: string, out: string[]): void => {
    const speakable = toSpeakableText(raw);
    if (!speakable) return;
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
      emittedCount = 0;
    },
  };
}
