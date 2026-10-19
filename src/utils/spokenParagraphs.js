// Keep spoken paragraph boundaries outside model-generated text. Only
// standalone English commands are recognised; ambiguous unpunctuated prose
// stays literal. This deliberately does not implement general voice commands.
const commandPattern = /(?<![\p{L}\p{N}_])new[ \t]+paragraph(?![\p{L}\p{N}_])/giu;
const literalPrefix =
  /\b(?:a|an|the|this|that|my|your|his|her|our|their|another|each|every|any|some|say|says|said|saying|words?|phrases?|commands?|terms?|options?|examples?|called|type|write|insert|add|start|mean|means|is|are|include|includes|including|about|discuss|discussed|mention|mentioned|named)[ \t]*[,;:]?[ \t]*$/iu;

function quotedRanges(text) {
  const ranges = [];
  let opening = -1;
  let closing = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (opening !== -1) {
      if (ch === closing) {
        // Contractions and plural possessives inside a quotation do not
        // end it. Ambiguous possessives conservatively keep the quote open.
        if (
          (ch === "'" || ch === "’") &&
          /[\p{L}\p{N}]/u.test(text[i - 1] || "") &&
          (/[\p{L}\p{N}]/u.test(text[i + 1] || "") ||
            (/s/iu.test(text[i - 1] || "") && /^[ \t]+[\p{L}\p{N}]/u.test(text.slice(i + 1))))
        )
          continue;
        ranges.push([opening, i + 1]);
        opening = -1;
      }
      continue;
    }
    // Apostrophes within words or after possessives are not opening quotes.
    if ((ch === "'" || ch === "‘") && /[\p{L}\p{N}]/u.test(text[i - 1] || "")) continue;
    const pairs = { '"': '"', "'": "'", "“": "”", "‘": "’", "`": "`" };
    if (pairs[ch]) {
      opening = i;
      closing = pairs[ch];
    }
  }
  if (opening !== -1) ranges.push([opening, text.length]);
  return ranges;
}

function paragraphParts(text, language) {
  if (typeof text !== "string" || !/^en(?:-|$)/i.test(language || "")) return null;
  const quotes = quotedRanges(text);
  const commands = [];
  for (const match of text.matchAll(commandPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (quotes.some(([a, b]) => start >= a && start < b)) continue;
    const before = text.slice(0, start);
    if (literalPrefix.test(before)) continue;
    // Require an utterance/clause boundary as well as an ending boundary.
    // Grammatical mentions such as "today's new paragraph" stay literal.
    // Commas and colons can introduce/continue literal lists, so they are
    // insufficient boundaries. A salutation is the narrow comma exception;
    // adjacent recognized commands still preserve repeated breaks.
    const adjacentCommand = commands.at(-1)?.end === start;
    const afterGreeting =
      /(?:^|[.!?;\r\n])[ \t]*(?:dear|hi|hello|hey)\b[^,.!?;:\r\n]*,[ \t]*$/iu.test(before);
    if (
      before.trim() &&
      !/[.!?;\r\n]["'”’)]*[ \t]*$/u.test(before) &&
      !afterGreeting &&
      !adjacentCommand
    )
      continue;
    const after = text.slice(end);
    // A command ends at punctuation, a line boundary, another standalone
    // command, or the end of the dictation. Avoid guessing from bare prose.
    if (!/^[ \t]*(?:[.!?;:,]|\r?\n|$)/u.test(after) && !/^[ \t]+new[ \t]+paragraph\b/iu.test(after))
      continue;
    const punctuation = after.match(/^[ \t]*[.!?;:,]*[ \t]*/u)[0];
    const remainder = after.slice(punctuation.length);
    // A comma after the phrase is equally ambiguous (including a first list
    // item). Preserve it unless the greeting/repeated-command context is clear.
    if (
      /^[ \t]*,+[ \t]*$/u.test(punctuation) &&
      remainder.trim() &&
      !afterGreeting &&
      !adjacentCommand &&
      !/^new[ \t]+paragraph\b/iu.test(remainder)
    )
      continue;
    commands.push({ start, end: end + punctuation.length });
  }
  if (!commands.length) return null;
  const parts = [];
  let cursor = 0;
  for (const command of commands) {
    parts.push({ text: text.slice(cursor, command.start).replace(/[ \t]+$/u, "") });
    parts.push({ separator: "\n\n" });
    cursor = command.end;
  }
  parts.push({ text: text.slice(cursor) });
  return parts;
}

export function normalizeSpokenParagraphs(text, language) {
  const parts = paragraphParts(text, language);
  return parts ? parts.map((part) => part.separator ?? part.text).join("") : text;
}

export function isParagraphOnlyResult(output, rawText, language) {
  if (typeof output !== "string" || !/^\n+$/u.test(output)) return false;
  const parts = paragraphParts(typeof rawText === "string" ? rawText.trim() : rawText, language);
  return (
    !!parts &&
    parts.every((part) => part.separator || !part.text.trim()) &&
    output === parts.map((part) => part.separator ?? part.text).join("")
  );
}

function words(text) {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    value: match[0].toLocaleLowerCase("en-GB"),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

// Prefer a long exact anchor; accept a shorter one only if it is unique in the
// complete output. Repeated/rewritten context is ambiguous, so never guess.
function anchor(text, outputWords, side, commandRanges) {
  const source = words(text);
  if (!source.length) return null;
  // One word is enough only when the source section itself is one word.
  // Otherwise preserve at least two words of surrounding context.
  for (let count = Math.min(6, source.length); count >= Math.min(2, source.length); count--) {
    const wanted = side === "left" ? source.slice(-count) : source.slice(0, count);
    const matches = [];
    for (let i = 0; i <= outputWords.length - count; i++) {
      const start = outputWords[i].start;
      const end = outputWords[i + count - 1].end;
      if (
        wanted.every((word, j) => word.value === outputWords[i + j].value) &&
        !commandRanges.some((range) => start < range.end && end > range.start)
      )
        matches.push(i);
    }
    if (matches.length === 1) {
      const index = matches[0];
      return side === "left" ? outputWords[index + count - 1].end : outputWords[index].start;
    }
  }
  return null;
}

function restoreParagraphs(parts, cleaned) {
  const original = parts.map((part) => part.separator ?? part.text).join("");
  if (typeof cleaned !== "string" || !cleaned.trim()) return original;
  const outputWords = words(cleaned);
  // A retained command cannot anchor its own boundary. Treat every occurrence
  // conservatively, including literal mentions that the model may have moved.
  const commandRanges = [...cleaned.matchAll(commandPattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const boundaries = [];
  let left = null;
  let pending = 0;
  for (const part of parts) {
    if (part.separator) {
      pending += 2;
      continue;
    }
    if (!part.text.trim()) {
      pending += (part.text.match(/\n/gu) || []).length;
      continue;
    }
    if (pending) boundaries.push({ left, right: part.text, count: pending });
    left = part.text;
    pending = 0;
  }
  if (pending) boundaries.push({ left, right: null, count: pending });

  const edits = [];
  for (const boundary of boundaries) {
    const start =
      boundary.left === null ? 0 : anchor(boundary.left, outputWords, "left", commandRanges);
    const end =
      boundary.right === null
        ? cleaned.length
        : anchor(boundary.right, outputWords, "right", commandRanges);
    if (start === null || end === null || start > end || start < (edits.at(-1)?.end ?? 0))
      return original;
    const gap = cleaned.slice(start, end);
    const commands = [...gap.matchAll(commandPattern)];
    // A line-start list/quote marker belongs to the following text, not to
    // the punctuation ending the previous paragraph. Keep it after the break.
    const rightMarker = boundary.right
      ? gap.match(/(?:^|\r?\n)([ \t]*[-*+•>][ \t]+)$/u)?.[1] || ""
      : "";
    const leftGap = rightMarker ? gap.slice(0, -rightMarker.length) : gap;
    // The gap may contain punctuation, whitespace and the recognised command
    // words only. A model rewrite putting document words here is not safe to
    // delete, and a quoted mention must never be consumed as a command.
    if (
      quotedRanges(gap).length ||
      /[()[\]{}]/u.test(gap) ||
      /[^.!?;:,\s]/u.test(leftGap.replace(commandPattern, "")) ||
      words(gap.replace(commandPattern, "")).length ||
      commands.length * 2 > boundary.count
    )
      return original;
    const prefix = (commands.length ? gap.slice(0, commands[0].index) : leftGap).trimEnd();
    const existing =
      ((boundary.left?.match(/\s*$/u)[0] || "") + (boundary.right?.match(/^\s*/u)[0] || "")).match(
        /\n/gu
      )?.length || 0;
    edits.push({
      start,
      end,
      replacement: prefix + "\n".repeat(boundary.count + existing) + rightMarker,
    });
  }
  let output = "";
  let cursor = 0;
  for (const edit of edits) {
    output += cleaned.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return output + cleaned.slice(cursor);
}

export async function cleanupSpokenParagraphs(
  text,
  cleanup,
  { language, wasCancelled = () => false } = {}
) {
  const parts = paragraphParts(text, language);
  if (!parts) return cleanup(text);
  if (wasCancelled()) return text;
  if (parts.every((part) => part.separator || !part.text.trim()))
    return normalizeSpokenParagraphs(text, language);
  // One request preserves the model's full context, latency and token budget.
  const cleaned = await cleanup(text);
  if (wasCancelled()) return text;
  return restoreParagraphs(parts, cleaned);
}
