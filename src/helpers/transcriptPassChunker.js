/**
 * Splits a transcript into chunks that each fit the local model's context.
 *
 * Dependency-free CommonJS on purpose: the post-call pipeline is main-process
 * CommonJS and truncates transcripts with `slice(0, 8000)`, which is the same
 * disease this module cures. Keeping it importable from there makes that a
 * mechanical follow-up rather than a rewrite.
 *
 * Not to be confused with `conversationChunker.js`, which chunks chat history
 * for embeddings.
 */

const { estimatePromptTokens, PROMPT_SHARE } = require("./llamaContext");

// Leaves room for the extraction system prompt and the compose scaffolding on
// top of the chunk itself.
const CHUNK_SHARE = 0.75;
// A ~15k-token prefill takes minutes on CPU and blows llama-server's per-request
// timeout. Smaller chunks cost more passes but each one completes.
const CPU_CHUNK_DIVISOR = 4;

const estimateTokens = estimatePromptTokens;

function resolveChunkBudget({ contextSize, isGpuBackend = true }) {
  const inputBudget = Math.floor(contextSize * PROMPT_SHARE);
  const base = Math.floor(inputBudget * CHUNK_SHARE);
  const chunkBudget = isGpuBackend ? base : Math.floor(base / CPU_CHUNK_DIVISOR);
  return { inputBudget, chunkBudget };
}

const renderLine = (segment) => {
  const text = String(segment?.text ?? "").trim();
  if (!text) return "";
  const label = String(segment?.label ?? "").trim();
  return label ? `${label}: ${text}` : text;
};

/**
 * Breaks a line that does not fit into pieces that do. Tries sentences first so
 * an extraction still sees whole thoughts, then falls back to words, then to a
 * hard character cut so a pathological input cannot loop forever.
 */
function splitOversizedLine(line, budgetTokens) {
  const pieces = [];
  const flushable = [];

  const sentences = line.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [line];
  for (const sentence of sentences) {
    if (estimateTokens(sentence) <= budgetTokens) {
      flushable.push(sentence);
      continue;
    }
    for (const word of sentence.split(/(\s+)/)) {
      if (estimateTokens(word) <= budgetTokens) {
        flushable.push(word);
        continue;
      }
      // A single "word" longer than the whole budget: cut it by characters.
      const maxChars = Math.max(1, Math.floor(budgetTokens * 3.6));
      for (let i = 0; i < word.length; i += maxChars) {
        flushable.push(word.slice(i, i + maxChars));
      }
    }
  }

  let current = "";
  for (const part of flushable) {
    const candidate = current + part;
    if (current && estimateTokens(candidate) > budgetTokens) {
      pieces.push(current.trim());
      current = part.trimStart();
    } else {
      current = candidate;
    }
  }
  if (current.trim()) pieces.push(current.trim());

  return pieces.filter(Boolean);
}

function packLines(lines, budgetTokens, overlapLines) {
  const chunks = [];
  let current = [];

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current.join("\n"));
    current = overlapLines > 0 ? current.slice(-overlapLines) : [];
    // The carried tail must never on its own exceed the budget.
    while (current.length > 0 && estimateTokens(current.join("\n")) > budgetTokens) {
      current.shift();
    }
  };

  for (const line of lines) {
    if (!line) continue;

    if (estimateTokens(line) > budgetTokens) {
      flush();
      current = [];
      for (const piece of splitOversizedLine(line, budgetTokens)) {
        chunks.push(piece);
      }
      continue;
    }

    const candidate = [...current, line];
    if (current.length > 0 && estimateTokens(candidate.join("\n")) > budgetTokens) {
      flush();
      current.push(line);
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) chunks.push(current.join("\n"));

  // The overlap carry can leave a trailing chunk that is only the carried tail.
  return dropRedundantTail(chunks);
}

function dropRedundantTail(chunks) {
  if (chunks.length < 2) return chunks;
  const last = chunks[chunks.length - 1];
  const prev = chunks[chunks.length - 2];
  return prev.endsWith(last) ? chunks.slice(0, -1) : chunks;
}

function chunkSegments(segments, budgetTokens, { overlapSegments = 1 } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return [];
  const lines = segments.map(renderLine).filter(Boolean);
  if (lines.length === 0) return [];
  return packLines(lines, budgetTokens, overlapSegments);
}

function chunkText(text, budgetTokens) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return [];
  if (estimateTokens(trimmed) <= budgetTokens) return [trimmed];
  const paragraphs = trimmed.split(/\n{2,}/).map((p) => p.trim());
  return packLines(paragraphs, budgetTokens, 0);
}

module.exports = {
  chunkSegments,
  chunkText,
  resolveChunkBudget,
  estimateTokens,
  CHUNK_SHARE,
};
