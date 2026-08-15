/**
 * Extracts transcription corrections by diffing original text against
 * the edited field value. Returns corrected words to add to the custom dictionary.
 */

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

/** Word-level LCS to find substitution blocks: arrays of [originalWord, editedWord].
 * A mismatched span often aligns as N deletes then N inserts; those are zipped
 * into one block so multi-word name fixes stay paired. */
function findSubstitutionBlocks(origWords, editedWords) {
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

  const blocks = [];
  let k = 0;
  while (k < aligned.length) {
    const [origW, editW] = aligned[k];
    if (origW !== null && editW !== null) {
      k++;
      continue;
    }

    const deletes = [];
    const inserts = [];
    while (k < aligned.length) {
      const [o, e] = aligned[k];
      if (o !== null && e !== null) break;
      if (o !== null && e === null) deletes.push(o);
      else if (o === null && e !== null) inserts.push(e);
      k++;
    }

    const paired = Math.min(deletes.length, inserts.length);
    if (paired === 0) continue;
    const block = [];
    for (let p = 0; p < paired; p++) {
      block.push([deletes[p], inserts[p]]);
    }
    blocks.push(block);
  }

  return blocks;
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

  const blocks = findSubstitutionBlocks(origWords, editedWords);
  const subs = blocks.flat();
  // If more than 50% of words changed, this is a rewrite, not corrections
  if (subs.length > origWords.length * 0.5) return [];

  const safeDict = Array.isArray(existingDictionary) ? existingDictionary : [];
  const dictSet = new Set(safeDict.map((w) => w.toLowerCase()));
  const seenCorrections = new Set();
  const results = [];

  for (const block of blocks) {
    const ratios = block.map(([origWord, correctedWord]) => {
      const dist = editDistance(origWord.toLowerCase(), correctedWord.toLowerCase());
      const maxLen = Math.max(origWord.length, correctedWord.length);
      return maxLen === 0 ? 1 : dist / maxLen;
    });
    // Single-word: keep the strict phonetic gate. Multi-word name fixes often
    // have one close pair and one looser pair — gate on the block average so
    // "Shunade Byrn" → "Sinead Byrne" can learn both.
    const gate =
      block.length === 1 ? ratios[0] : ratios.reduce((a, b) => a + b, 0) / ratios.length;
    // 0.65 threshold allows phonetic corrections like "Shunade" → "Sinead" (dist 4/7 = 0.57)
    // while filtering out unrelated word replacements.
    if (gate > 0.65) continue;

    for (const [origWord, correctedWord] of block) {
      const normalizedCorrected = correctedWord.toLowerCase();

      if (dictSet.has(normalizedCorrected)) continue;
      if (seenCorrections.has(normalizedCorrected)) continue;
      if (origWord.toLowerCase() === normalizedCorrected) continue;
      if (correctedWord.length < 3) continue;

      results.push(correctedWord);
      seenCorrections.add(normalizedCorrected);
    }
  }

  return results;
}

module.exports = { extractCorrections };
