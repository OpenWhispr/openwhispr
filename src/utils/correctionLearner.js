/**
 * Extracts transcription corrections by diffing original text against
 * the edited field value. Returns corrected words to add to the custom dictionary.
 */

// Swapping one everyday word for another ("why" -> "what") is a content edit,
// not vocabulary; learning it would only pad the cleanup prompt. Words under
// three letters are already dropped, so none are listed here.
const COMMON_WORDS = new Set(
  `the and for not with you this but his from they say her she will one all would
  there their what out about who get which when make can like time just him know
  take into year your good some could them see other than then now look only come
  over think also back after use two how our work first well way even new want
  because any these give day most are was were been has had did does said went
  made got came took saw knew thought where why here very much many still too again
  off down never every own same another both each few more less last next while
  before through under between should might must being have that its yes okay`.split(/\s+/)
);

/** Levenshtein edit distance between two strings */
function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/** Tokenize text into words, stripping punctuation from edges */
function tokenize(text) {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, ""))
    .filter((w) => w.length > 0);
}

/**
 * Find the region in fieldValue that corresponds to the pasted originalText.
 * If the field only contains the pasted text, returns fieldValue as-is.
 */
function findEditedRegion(originalText, fieldValue) {
  if (fieldValue.length <= originalText.length * 1.5) {
    return fieldValue;
  }

  const idx = fieldValue.indexOf(originalText);
  if (idx !== -1) {
    return originalText;
  }

  // Sliding window: find the region with highest word overlap
  const origWords = tokenize(originalText);
  const fieldWords = tokenize(fieldValue);
  const windowSize = origWords.length;

  if (fieldWords.length <= windowSize) {
    return fieldValue;
  }

  let bestStart = 0;
  let bestScore = -1;

  for (let i = 0; i <= fieldWords.length - windowSize; i++) {
    let matches = 0;
    for (let j = 0; j < windowSize; j++) {
      if (fieldWords[i + j].toLowerCase() === origWords[j].toLowerCase()) {
        matches++;
      }
    }
    if (matches > bestScore) {
      bestScore = matches;
      bestStart = i;
    }
  }

  // Require at least 30% word overlap to consider it a match
  if (bestScore < windowSize * 0.3) {
    return fieldValue;
  }

  return fieldWords.slice(bestStart, bestStart + windowSize).join(" ");
}

/** Word-level LCS to find [originalWord, editedWord] substitution pairs. */
function findSubstitutions(origWords, editedWords) {
  const m = origWords.length;
  const n = editedWords.length;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (origWords[i - 1].toLowerCase() === editedWords[j - 1].toLowerCase()) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const aligned = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origWords[i - 1].toLowerCase() === editedWords[j - 1].toLowerCase()) {
      aligned.unshift([origWords[i - 1], editedWords[j - 1]]);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      aligned.unshift([null, editedWords[j - 1]]);
      j--;
    } else {
      aligned.unshift([origWords[i - 1], null]);
      i--;
    }
  }

  // Consecutive [origWord, null] + [null, editedWord] = substitution
  const subs = [];
  for (let k = 0; k < aligned.length - 1; k++) {
    const [origW, editW] = aligned[k];
    const [nextOrigW, nextEditW] = aligned[k + 1];

    if (origW !== null && editW === null && nextOrigW === null && nextEditW !== null) {
      subs.push([origW, nextEditW]);
    }
  }

  return subs;
}

/**
 * Extract corrected words from a user's edits to pasted transcription text.
 *
 * @param {string} originalText - The text that was originally pasted (from transcription)
 * @param {string} fieldValue - The current value of the text field (after user edits)
 * @param {string[]} existingDictionary - Words already in the custom dictionary
 * @returns {string[]} Array of corrected words to add to the dictionary
 */
function extractCorrections(originalText, fieldValue, existingDictionary) {
  if (!originalText || !fieldValue) return [];
  if (originalText === fieldValue) return [];

  const editedRegion = findEditedRegion(originalText, fieldValue);
  if (editedRegion === originalText) return [];

  const origWords = tokenize(originalText);
  const editedWords = tokenize(editedRegion);

  if (origWords.length === 0 || editedWords.length === 0) return [];

  // If more than 50% of words changed, this is a rewrite, not corrections
  const subs = findSubstitutions(origWords, editedWords);
  if (subs.length > origWords.length * 0.5) return [];

  const safeDict = Array.isArray(existingDictionary) ? existingDictionary : [];
  const dictSet = new Set(safeDict.map((w) => w.toLowerCase()));
  const seenCorrections = new Set();
  const results = [];

  for (const [origWord, correctedWord] of subs) {
    const normalizedCorrected = correctedWord.toLowerCase();

    if (dictSet.has(normalizedCorrected)) continue;
    if (seenCorrections.has(normalizedCorrected)) continue;
    if (origWord.toLowerCase() === normalizedCorrected) continue;
    if (correctedWord.length < 3) continue;
    if (COMMON_WORDS.has(normalizedCorrected)) continue;

    // 0.65 threshold allows phonetic corrections like "Shunade" → "Sinead" (dist 4/7 = 0.57)
    // while filtering out unrelated word replacements.
    const dist = editDistance(origWord.toLowerCase(), correctedWord.toLowerCase());
    const maxLen = Math.max(origWord.length, correctedWord.length);
    if (dist / maxLen > 0.65) continue;

    results.push(correctedWord);
    seenCorrections.add(normalizedCorrected);
  }

  return results;
}

module.exports = { extractCorrections };
