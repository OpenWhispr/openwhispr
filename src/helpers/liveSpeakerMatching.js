"use strict";

/**
 * Accept/reject policy for matching a voice embedding to an already-known
 * speaker during live diarization.
 *
 * History: the margin rule below used to be unconditional, and commit a8f70284
 * ("remove speaker count cap") deleted the force-merge backstop that had been
 * hiding its cost. Together those produced a runaway — once one person had two
 * clusters, both scored high for that person's voice, the top-two gap fell
 * under the margin, no match was accepted, and yet another duplicate cluster
 * was created. Every duplicate made the next match harder. A 3-person call
 * reported speaker_23, speaker_27, speaker_28.
 *
 * The fix is to recognise what a near-tie actually means. Two candidates that
 * BOTH strongly resemble the incoming voice are almost certainly duplicates of
 * one speaker; that is a reason to merge, not to split. The margin rule is only
 * meaningful in the weak band, where a tie really does mean "could be either
 * person".
 */

const MATCH_THRESHOLD = 0.65;
const MATCH_MARGIN = 0.03;
// Above this similarity we trust the match outright and ignore the runner-up.
const CONFIDENT_MATCH_THRESHOLD = 0.8;

/**
 * @param {number} bestSimilarity      cosine similarity of the closest cluster
 * @param {number} secondBestSimilarity similarity of the next closest, or -Infinity/0 if none
 * @returns {boolean} whether to reuse the closest existing speaker
 */
function acceptsMatch(bestSimilarity, secondBestSimilarity) {
  if (!Number.isFinite(bestSimilarity) || bestSimilarity < MATCH_THRESHOLD) return false;
  if (bestSimilarity >= CONFIDENT_MATCH_THRESHOLD) return true;

  const runnerUp = Number.isFinite(secondBestSimilarity) ? secondBestSimilarity : 0;
  return bestSimilarity - runnerUp >= MATCH_MARGIN;
}

module.exports = {
  MATCH_THRESHOLD,
  MATCH_MARGIN,
  CONFIDENT_MATCH_THRESHOLD,
  acceptsMatch,
};
