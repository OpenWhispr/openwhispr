/**
 * Matches live voiceprints against the speakers heard so far in this meeting, as desktop's
 * live identifier does (src/helpers/liveSpeakerIdentifier.js): a voice joins the closest speaker
 * when it clears the match bar by a margin over the runner-up, otherwise it is a new speaker;
 * every few lines, speakers whose centroids came out close enough are merged.
 */
export const MATCH_THRESHOLD = 0.6;
export const RECLUSTER_THRESHOLD = 0.7;
export const MATCH_MARGIN = 0.03;

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

export interface Match {
  label: string;
  similarity: number;
  /** True when this voice started a new speaker. */
  created: boolean;
}

export function createSpeakerMatcher(options: { maxSpeakers?: number } = {}) {
  const centroids = new Map<string, { vector: number[]; count: number }>();
  let next = 0;

  const ranked = (embedding: number[]) =>
    [...centroids.entries()]
      .map(([label, { vector }]) => ({ label, similarity: cosineSimilarity(embedding, vector) }))
      .sort((a, b) => b.similarity - a.similarity);

  const fold = (label: string, embedding: number[]) => {
    const centroid = centroids.get(label)!;
    centroid.vector = centroid.vector.map(
      (value, index) => (value * centroid.count + embedding[index]) / (centroid.count + 1),
    );
    centroid.count += 1;
  };

  return {
    assign(embedding: number[]): Match {
      const [best, second] = ranked(embedding);
      if (
        best &&
        best.similarity >= MATCH_THRESHOLD &&
        best.similarity - (second?.similarity ?? 0) >= MATCH_MARGIN
      ) {
        fold(best.label, embedding);
        return { label: best.label, similarity: best.similarity, created: false };
      }
      // At the expected head count, a voice is labelled with its nearest speaker but never
      // folded in: an overflow is usually someone else, and would pull the centroid away.
      if (best && options.maxSpeakers && centroids.size >= options.maxSpeakers)
        return { label: best.label, similarity: best.similarity, created: false };
      // Labels are never reused, so a merged-away speaker can't hand its name to a new voice.
      const label = `speaker_${next++}`;
      centroids.set(label, { vector: [...embedding], count: 1 });
      return { label, similarity: best?.similarity ?? 0, created: true };
    },

    /** Merges speakers that turned out to be one voice; the busier one keeps its label. */
    recluster(): { keep: string; remove: string; similarity: number }[] {
      const merges: { keep: string; remove: string; similarity: number }[] = [];
      const labels = [...centroids.keys()];
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const first = centroids.get(labels[i]);
          const second = centroids.get(labels[j]);
          if (!first || !second) continue;
          const similarity = cosineSimilarity(first.vector, second.vector);
          if (similarity < RECLUSTER_THRESHOLD) continue;
          const [keep, remove] =
            first.count >= second.count ? [labels[i], labels[j]] : [labels[j], labels[i]];
          const kept = centroids.get(keep)!;
          const removed = centroids.get(remove)!;
          const total = kept.count + removed.count;
          kept.vector = kept.vector.map(
            (value, index) => (value * kept.count + removed.vector[index] * removed.count) / total,
          );
          kept.count = total;
          centroids.delete(remove);
          merges.push({ keep, remove, similarity });
        }
      }
      return merges;
    },

    get size() {
      return centroids.size;
    },
  };
}
