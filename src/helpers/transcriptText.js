const TOKEN_COVERAGE_THRESHOLD = 0.6;
const TOKEN_SEQUENCE_THRESHOLD = 0.6;
const MIN_TOKENS_FOR_OVERLAP = 3;
const MEANINGFUL_TOKEN_COVERAGE_THRESHOLD = 0.55;
const MEANINGFUL_TOKEN_SEQUENCE_THRESHOLD = 0.55;
const MIN_MEANINGFUL_TOKENS_FOR_OVERLAP = 4;

const LOW_SIGNAL_TOKENS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "but",
  "by",
  "d",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "his",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "ll",
  "m",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "out",
  "re",
  "s",
  "she",
  "so",
  "t",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "ve",
  "was",
  "we",
  "well",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "without",
  "you",
  "your",
]);

const normalizeTranscriptText = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const longestCommonTokenSubsequence = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp[a.length][b.length];
};

const countCommonTokens = (a, b) => {
  const counts = new Map();
  let common = 0;

  for (const token of a) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }

  for (const token of b) {
    const remaining = counts.get(token) || 0;
    if (remaining <= 0) continue;
    counts.set(token, remaining - 1);
    common += 1;
  }

  return common;
};

const toMeaningfulTokens = (text) =>
  text
    .split(" ")
    .filter(Boolean)
    .filter((token) => token.length > 1 && !LOW_SIGNAL_TOKENS.has(token));

const transcriptsOverlap = (a, b) => {
  const normalizedA = typeof a === "string" ? normalizeTranscriptText(a) : a;
  const normalizedB = typeof b === "string" ? normalizeTranscriptText(b) : b;
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return true;

  const tokensA = normalizedA.split(" ");
  const tokensB = normalizedB.split(" ");
  const shorter = Math.min(tokensA.length, tokensB.length);
  if (shorter < MIN_TOKENS_FOR_OVERLAP) return false;

  const common = countCommonTokens(tokensA, tokensB);
  if (common / shorter >= TOKEN_COVERAGE_THRESHOLD) {
    return true;
  }

  const sequence = longestCommonTokenSubsequence(tokensA, tokensB);
  return sequence / shorter >= TOKEN_SEQUENCE_THRESHOLD;
};

const transcriptsLooselyOverlap = (a, b) => {
  const normalizedA = typeof a === "string" ? normalizeTranscriptText(a) : a;
  const normalizedB = typeof b === "string" ? normalizeTranscriptText(b) : b;
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) return true;

  const tokensA = toMeaningfulTokens(normalizedA);
  const tokensB = toMeaningfulTokens(normalizedB);
  const shorter = Math.min(tokensA.length, tokensB.length);
  if (shorter < MIN_MEANINGFUL_TOKENS_FOR_OVERLAP) return false;

  const common = countCommonTokens(tokensA, tokensB);
  if (common / shorter >= MEANINGFUL_TOKEN_COVERAGE_THRESHOLD) {
    return true;
  }

  const sequence = longestCommonTokenSubsequence(tokensA, tokensB);
  return sequence / shorter >= MEANINGFUL_TOKEN_SEQUENCE_THRESHOLD;
};

const buildMergedCandidates = ({
  segments,
  timestamp,
  windowMs,
  mergeLimit,
  extraSegment = null,
}) => {
  const nearby = segments.filter(
    (seg) =>
      seg.text &&
      (seg.timestamp == null ||
        timestamp == null ||
        Math.abs(seg.timestamp - timestamp) <= windowMs)
  );

  if (extraSegment?.text) {
    nearby.push({
      text: extraSegment.text,
      timestamp: extraSegment.timestamp ?? timestamp ?? Date.now(),
    });
  }

  nearby.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));

  const texts = new Set();
  for (let start = 0; start < nearby.length; start += 1) {
    let merged = "";
    for (let end = start; end < nearby.length && end < start + mergeLimit; end += 1) {
      merged += `${merged ? " " : ""}${nearby[end].text}`;
      texts.add(merged);
    }
  }

  return [...texts];
};

module.exports = { transcriptsOverlap, transcriptsLooselyOverlap, buildMergedCandidates };
