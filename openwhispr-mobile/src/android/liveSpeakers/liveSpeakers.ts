import type { LineSpan } from './lineClock';
import { createSpeakerMatcher } from './speakerMatcher';

/** Lines shorter than this get their speaker from the lines around them. */
export const MIN_VOICEPRINT_MS = 1500;
const RECLUSTER_EVERY = 8;
const MODEL_RECHECK_MS = 30_000;
const MAX_FAILURES = 3;
// A provider's "not sure yet" values, which carry no speaker.
const NO_PROVIDER_SPEAKER = new Set(['PENDING', 'UNKNOWN', '-1']);

export interface LiveSpeakerDeps {
  /** A voiceprint for a span of the meeting WAV, computed off the JS thread. */
  embed(startMs: number, endMs: number): Promise<number[]>;
  modelReady(): Promise<boolean>;
  log?(message: string): void;
  now?(): number;
}

export interface LiveSpeakers {
  line(span: LineSpan): void;
  /** Speaker label per utterance id (`speaker_N`), as far as it is known now. */
  labels(): Record<string, string>;
  /** Every line's span on the WAV clock. */
  spans(): Record<string, LineSpan>;
  /** True once the provider labelled speakers itself. */
  providerLabelled(): boolean;
  /** Waits for queued voiceprints, at most `timeoutMs`. */
  drain(timeoutMs: number): Promise<void>;
  /** Stops taking voiceprints; lines already labelled keep their labels. */
  stop(): void;
}

/**
 * Live speaker labels for one meeting. A provider that labels speakers (Deepgram, AssemblyAI)
 * is used as it is; otherwise each line long enough gets a voiceprint, one at a time, matched
 * against the speakers heard so far. Labels arrive a beat after the text; `onChange` fires for
 * each change so the captions can follow.
 */
export function createLiveSpeakers(
  deps: LiveSpeakerDeps,
  options: { maxSpeakers?: number; onChange?: (labels: Record<string, string>) => void } = {},
): LiveSpeakers {
  const now = deps.now ?? Date.now;
  const matcher = createSpeakerMatcher({ maxSpeakers: options.maxSpeakers });
  const order: string[] = [];
  const spans: Record<string, LineSpan> = {};
  const voiced: Record<string, string> = {};
  const fromProvider: Record<string, string> = {};
  const providerIds = new Map<string, string>();
  let queue: string[] = [];
  let working = false;
  let stopped = false;
  let failures = 0;
  let assigned = 0;
  let ready: boolean | null = null;
  let checkedAt = -Infinity;
  let labelled = false;
  let published = '';
  let idle: (() => void)[] = [];

  const labels = (): Record<string, string> => {
    const known = labelled ? fromProvider : voiced;
    const result: Record<string, string> = {};
    order.forEach((id, index) => {
      if (known[id]) {
        result[id] = known[id];
        return;
      }
      // A short line takes its neighbours' speaker once both sides agree.
      let before: string | undefined;
      for (let i = index - 1; i >= 0 && !before; i--) before = known[order[i]];
      let after: string | undefined;
      for (let i = index + 1; i < order.length && !after; i++) after = known[order[i]];
      if (before && before === after) result[id] = before;
    });
    return result;
  };

  const publish = () => {
    const current = labels();
    const key = JSON.stringify(current);
    if (key === published) return;
    published = key;
    options.onChange?.(current);
  };

  const pump = async () => {
    if (working || stopped) return;
    working = true;
    try {
      while (queue.length && !stopped) {
        if (ready !== true) {
          if (now() - checkedAt < MODEL_RECHECK_MS) break;
          checkedAt = now();
          ready = await deps.modelReady().catch(() => false);
          if (!ready) break;
        }
        const id = queue.shift()!;
        const span = spans[id];
        const started = now();
        try {
          const embedding = await deps.embed(span.startMs, span.endMs);
          if (stopped || labelled) return;
          failures = 0;
          const match = matcher.assign(embedding);
          voiced[id] = match.label;
          deps.log?.(
            `[live-speakers] line ${span.endMs - span.startMs}ms -> ${match.label} ` +
              `sim=${match.similarity.toFixed(3)}${match.created ? ' new' : ''} ` +
              `took=${now() - started}ms queued=${queue.length}`,
          );
          if (++assigned % RECLUSTER_EVERY === 0) {
            for (const merge of matcher.recluster()) {
              for (const key of Object.keys(voiced))
                if (voiced[key] === merge.remove) voiced[key] = merge.keep;
              deps.log?.(
                `[live-speakers] merged ${merge.remove} into ${merge.keep} sim=${merge.similarity.toFixed(3)}`,
              );
            }
          }
          publish();
        } catch (error) {
          deps.log?.(
            `[live-speakers] voiceprint failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (++failures >= MAX_FAILURES) {
            stopped = true;
            queue = [];
          }
        }
      }
    } finally {
      working = false;
      const waiting = idle;
      idle = [];
      waiting.forEach((resolve) => resolve());
    }
  };

  return {
    line(span) {
      if (spans[span.itemId]) return;
      spans[span.itemId] = span;
      order.push(span.itemId);
      // What the first lines carry tells, in logcat, whether the provider labels speakers.
      if (order.length <= 3)
        deps.log?.(
          `[live-speakers] line ${order.length}: ${span.endMs - span.startMs}ms ` +
            `provider=${span.providerSpeaker ?? 'none'}${span.estimated ? ' estimated' : ''}`,
        );
      const provider = span.providerSpeaker;
      if (provider !== null && !NO_PROVIDER_SPEAKER.has(provider.toUpperCase())) {
        if (!labelled) {
          labelled = true;
          queue = [];
        }
        if (!providerIds.has(provider)) providerIds.set(provider, `speaker_${providerIds.size}`);
        fromProvider[span.itemId] = providerIds.get(provider)!;
      } else if (!labelled && span.endMs - span.startMs >= MIN_VOICEPRINT_MS) {
        queue.push(span.itemId);
        void pump();
      }
      publish();
    },
    labels,
    spans: () => ({ ...spans }),
    providerLabelled: () => labelled,
    drain(timeoutMs) {
      if (!working) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        idle.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    stop() {
      stopped = true;
      queue = [];
    },
  };
}
