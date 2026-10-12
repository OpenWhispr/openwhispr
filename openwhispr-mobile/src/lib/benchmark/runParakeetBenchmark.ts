import { ParakeetASR, type ParakeetTranscribeResult } from '../../../modules/parakeet-asr/src';
import { LocalWhisperService } from '@/services/transcription/LocalWhisperService';
import { LocalParakeetService } from '@/services/transcription/LocalParakeetService';

// Orchestrates the Parakeet-vs-Whisper spike: same recorded WAV through each selected engine, one cold
// run + N warm runs, releasing each engine before the next so peak-memory measurements start from a clean
// baseline. Every engine is measured with the SAME native phys_footprint sampler (Parakeet inline,
// Whisper via startMemorySampling/stopMemorySampling) so the memory A/B is apples-to-apples.
//
// The two numbers that decide the migration: warm-median RTF and peak memory on real iPhone hardware.

export type BenchEngine = 'parakeet-v3' | 'parakeet-v2' | 'whisper-base';

export interface EngineRunResult {
  engine: BenchEngine;
  label: string;
  ok: boolean;
  error?: string;
  modelSizeBytes?: number;
  /** Model load + engine build time (excluded from RTF). */
  loadMs?: number;
  coldInferMs?: number;
  warmMedianInferMs?: number;
  /** audioSeconds / (warmMedianInferMs/1000). Higher = faster than real time. */
  rtf?: number;
  peakBytes?: number;
  minAvailableBytes?: number;
  audioSeconds?: number;
  confidence?: number;
  text?: string;
}

export const ENGINE_LABEL: Record<BenchEngine, string> = {
  'parakeet-v3': 'Parakeet v3 (int8)',
  'parakeet-v2': 'Parakeet v2 (English)',
  'whisper-base': 'Whisper base',
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function whisperBaseSizeBytes(): Promise<number | undefined> {
  const models = await LocalWhisperService.getAvailableModels();
  return models.find((m) => m.name === 'base')?.size;
}

interface RunOptions {
  warmRuns?: number;
  onProgress?: (message: string) => void;
}

async function runParakeetEngine(
  engine: 'parakeet-v3' | 'parakeet-v2',
  wavUri: string,
  warmRuns: number,
  report: (message: string) => void,
): Promise<EngineRunResult> {
  const label = ENGINE_LABEL[engine];
  const version = engine === 'parakeet-v3' ? 'v3' : 'v2';

  // prepare() is load-only in production, so the download is a separate, separately-timed step —
  // this is what splits network cost from CoreML's one-time ANE compile (visible as a large
  // first-ever loadMs that collapses on subsequent prepares).
  let downloadMs: number | undefined;
  if (!(await ParakeetASR.isModelDownloaded(version))) {
    report(`${label} · downloading model…`);
    const downloadStart = Date.now();
    await LocalParakeetService.downloadModel(version);
    downloadMs = Date.now() - downloadStart;
  }

  report(`${label} · loading model…`);
  const { loadMs, modelSizeBytes } = await ParakeetASR.prepare(version);
  if (__DEV__) {
    console.log(
      `[parakeet-bench] ${label} downloadMs=${downloadMs ?? 0} loadMs=${Math.round(loadMs)}`,
    );
  }

  report(`${label} · cold run…`);
  const cold = await ParakeetASR.transcribe(wavUri, version, { sampleMemory: true });

  const warm: ParakeetTranscribeResult[] = [];
  for (let i = 0; i < warmRuns; i += 1) {
    report(`${label} · warm run ${i + 1}/${warmRuns}…`);
    warm.push(await ParakeetASR.transcribe(wavUri, version, { sampleMemory: true }));
  }
  await ParakeetASR.release();

  const warmMedian = median(warm.map((r) => r.inferMs));
  const last = warm[warm.length - 1] ?? cold;
  return {
    engine,
    label,
    ok: true,
    modelSizeBytes,
    loadMs,
    coldInferMs: cold.inferMs,
    warmMedianInferMs: warmMedian,
    rtf: warmMedian > 0 ? cold.audioSeconds / (warmMedian / 1000) : undefined,
    peakBytes: Math.max(...warm.map((r) => r.peakBytes ?? 0)),
    minAvailableBytes: Math.min(
      ...warm.map((r) => r.minAvailableBytes ?? Number.POSITIVE_INFINITY),
    ),
    audioSeconds: cold.audioSeconds,
    confidence: last.confidence,
    text: last.text,
  };
}

async function runWhisperBase(
  wavUri: string,
  warmRuns: number,
  clipSeconds: number | undefined,
  report: (message: string) => void,
): Promise<EngineRunResult> {
  // Warm the native context first so model init isn't counted in the timed runs.
  report('Whisper base · warming…');
  await LocalWhisperService.prepareForLanguage('en');

  const runOnce = async () => {
    await ParakeetASR.startMemorySampling();
    const res = await LocalWhisperService.transcribe(wavUri, {
      modelName: 'base',
      language: 'en',
      wordTimestamps: false,
    });
    const mem = await ParakeetASR.stopMemorySampling();
    return { inferMs: res.processingMs ?? 0, text: res.text, mem };
  };

  report('Whisper base · cold run…');
  const cold = await runOnce();

  const warm: Array<{
    inferMs: number;
    text: string;
    mem: Awaited<ReturnType<typeof runOnce>>['mem'];
  }> = [];
  for (let i = 0; i < warmRuns; i += 1) {
    report(`Whisper base · warm run ${i + 1}/${warmRuns}…`);
    warm.push(await runOnce());
  }
  await LocalWhisperService.cleanup();

  const warmMedian = median(warm.map((r) => r.inferMs));
  return {
    engine: 'whisper-base',
    label: ENGINE_LABEL['whisper-base'],
    ok: true,
    modelSizeBytes: await whisperBaseSizeBytes(),
    coldInferMs: cold.inferMs,
    warmMedianInferMs: warmMedian,
    // Whisper's response.duration is processing time, not audio length — reuse the clip length that
    // Parakeet measured from the identical file so RTF is comparable.
    rtf: clipSeconds && warmMedian > 0 ? clipSeconds / (warmMedian / 1000) : undefined,
    peakBytes: Math.max(...warm.map((r) => r.mem.peakBytes)),
    minAvailableBytes: Math.min(...warm.map((r) => r.mem.minAvailableBytes)),
    audioSeconds: clipSeconds,
    text: warm[warm.length - 1]?.text ?? cold.text,
  };
}

export async function runBenchmark(
  wavUri: string,
  engines: BenchEngine[],
  options: RunOptions = {},
): Promise<EngineRunResult[]> {
  const warmRuns = options.warmRuns ?? 3;
  const report = options.onProgress ?? (() => {});
  const results: EngineRunResult[] = [];

  // Parakeet runs first so it establishes the clip's true audio length (from its own decoder), which
  // Whisper then reuses for a comparable RTF. Engines are ordered parakeet-first for that reason.
  const ordered = [...engines].sort(
    (a, b) => Number(a === 'whisper-base') - Number(b === 'whisper-base'),
  );

  let clipSeconds: number | undefined;
  for (const engine of ordered) {
    try {
      const result =
        engine === 'whisper-base'
          ? await runWhisperBase(wavUri, warmRuns, clipSeconds, report)
          : await runParakeetEngine(engine, wavUri, warmRuns, report);
      clipSeconds = clipSeconds ?? result.audioSeconds;
      results.push(result);
    } catch (error) {
      // Never leave a warm engine resident after a failure — it would inflate the next engine's peak.
      try {
        await ParakeetASR.release();
      } catch {
        /* ignore */
      }
      results.push({
        engine,
        label: ENGINE_LABEL[engine],
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
