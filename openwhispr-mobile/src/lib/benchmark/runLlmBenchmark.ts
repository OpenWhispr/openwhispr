import { AppState, type AppStateStatus } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { initLlama, type LlamaContext, type NativeCompletionResult } from 'llama.rn';
import { ParakeetASR, type DeviceInfo } from '../../../modules/parakeet-asr/src';
import { notesRepository } from '@/data';
import { formatTranscriptForExport } from '@/lib/diarization/transcriptDisplay';
import { buildMeetingNotesInput } from '@/lib/notes/meetingNotesInput';
import { buildActionSystemPrompt } from '@/lib/notes/generateNotesPrompt';
import { buildProviderPrompt, stripThinkingTags } from '@/services/reasoning/buildProviderPrompt';
import { LocalWhisperService } from '@/services/transcription/LocalWhisperService';
import { LocalParakeetService } from '@/services/transcription/LocalParakeetService';
import {
  CLEANUP_LONG_FIXTURE,
  CLEANUP_SHORT_FIXTURE,
  SYNTHETIC_MEETING_LINES,
} from '@/lib/benchmark/llmBenchmarkFixtures';

// Dev-only spike (docs/superpowers/plans/2026-10-07-mobile-local-llm-qwen.md, Phase 0): runs the
// candidate on-device LLMs through llama.rn on this iPhone with the app's real cleanup and
// meeting-notes prompts, and records what decides Phase 1: peak phys_footprint (what Jetsam
// meters), load time, prefill and decode speed, whether thinking stays off, whether JSON-schema
// output parses, and whether a run survives the app being backgrounded. Never shipped to users;
// reached only by route.

export type SpikeModelId = 'qwen3.5-2b' | 'minicpm5-2b' | 'lfm3-1.7b';

export interface SpikeModel {
  id: SpikeModelId;
  label: string;
  repo: string;
  /** Picks the Q4_K_M file from the repo listing, since uploaders name it differently. */
  filePattern: RegExp;
  approxSize: string;
}

export const SPIKE_MODELS: readonly SpikeModel[] = [
  {
    id: 'qwen3.5-2b',
    label: 'Qwen3.5 2B',
    repo: 'bartowski/Qwen_Qwen3.5-2B-GGUF',
    filePattern: /Q4_K_M\.gguf$/i,
    approxSize: '1.3 GB',
  },
  {
    id: 'minicpm5-2b',
    label: 'MiniCPM5 2B',
    repo: 'bartowski/MiniCPM5-2B-GGUF',
    filePattern: /Q4_K_M\.gguf$/i,
    approxSize: '1.6 GB',
  },
  // LFM Open License: free for companies under $10M annual revenue. Its lfm3 architecture needs
  // llama.rn 0.13.0-rc.9 or later, which is why only this branch carries it.
  {
    id: 'lfm3-1.7b',
    label: 'LFM3 1.7B',
    repo: 'bartowski/LFM3-1.7B-GGUF',
    filePattern: /Q4_K_M\.gguf$/i,
    approxSize: '1.1 GB',
  },
];

export function spikeModel(id: SpikeModelId): SpikeModel {
  const model = SPIKE_MODELS.find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Unknown model ${id}`);
  return model;
}

const BENCH_DIR = `${FileSystem.documentDirectory}llm-bench/`;
const modelPath = (id: SpikeModelId): string => `${BENCH_DIR}${id}.gguf`;

export interface HubTreeEntry {
  type: string;
  path: string;
  size?: number;
  lfs?: { size?: number };
}

// One file from a Hugging Face repo listing, with its exact size so the download can be checked.
export function pickModelFile(
  entries: HubTreeEntry[],
  pattern: RegExp,
): { path: string; size: number } | null {
  const file = entries.find((entry) => entry.type === 'file' && pattern.test(entry.path));
  const size = file?.lfs?.size ?? file?.size;
  return file && size ? { path: file.path, size } : null;
}

async function resolveModelFile(model: SpikeModel): Promise<{ url: string; size: number }> {
  const response = await fetch(`https://huggingface.co/api/models/${model.repo}/tree/main`);
  if (!response.ok) throw new Error(`Could not list ${model.repo} (HTTP ${response.status}).`);
  const file = pickModelFile((await response.json()) as HubTreeEntry[], model.filePattern);
  if (!file) throw new Error(`No Q4_K_M file in ${model.repo}.`);
  const path = file.path.split('/').map(encodeURIComponent).join('/');
  return { url: `https://huggingface.co/${model.repo}/resolve/main/${path}`, size: file.size };
}

export async function getSpikeModelSize(id: SpikeModelId): Promise<number | null> {
  const info = await FileSystem.getInfoAsync(modelPath(id));
  return info.exists && !info.isDirectory ? info.size : null;
}

// The file only reaches its final path after its size matched the listing, so a file there is
// always complete.
export async function downloadSpikeModel(
  id: SpikeModelId,
  onProgress: (fraction: number) => void,
): Promise<void> {
  const { url, size } = await resolveModelFile(spikeModel(id));
  await FileSystem.makeDirectoryAsync(BENCH_DIR, { intermediates: true }).catch(() => undefined);
  const partial = `${modelPath(id)}.partial`;
  await FileSystem.deleteAsync(partial, { idempotent: true });
  const download = FileSystem.createDownloadResumable(url, partial, {}, (event) => {
    onProgress(event.totalBytesWritten / size);
  });
  const result = await download.downloadAsync();
  if (!result || result.status < 200 || result.status >= 300) {
    await FileSystem.deleteAsync(partial, { idempotent: true });
    throw new Error(`Model download failed (HTTP ${result?.status ?? 'none'}).`);
  }
  const info = await FileSystem.getInfoAsync(partial);
  if (!info.exists || info.isDirectory || info.size !== size) {
    await FileSystem.deleteAsync(partial, { idempotent: true });
    throw new Error('The downloaded file is not the expected size.');
  }
  await FileSystem.deleteAsync(modelPath(id), { idempotent: true });
  await FileSystem.moveAsync({ from: partial, to: modelPath(id) });
}

export async function deleteSpikeModel(id: SpikeModelId): Promise<void> {
  await FileSystem.deleteAsync(modelPath(id), { idempotent: true });
  await FileSystem.deleteAsync(`${modelPath(id)}.partial`, { idempotent: true });
}

// Room left in the context for the meeting-notes reply and the chat template around the prompt.
const NOTES_OUTPUT_TOKENS = 1024;
const NOTES_TEMPLATE_MARGIN_TOKENS = 256;
const CLEANUP_OUTPUT_TOKENS = 1024;
const OUTPUT_PREVIEW_CHARS = 4000;

export const MEETING_NOTES_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    keyDiscussionPoints: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          owner: { type: ['string', 'null'] },
        },
        required: ['text'],
      },
    },
    followUps: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'keyDiscussionPoints', 'decisions', 'actionItems', 'followUps'],
} as const;

export type LlmScenarioName = 'cleanup-short' | 'cleanup-long' | 'meeting-notes';

export interface LlmScenarioResult {
  name: LlmScenarioName;
  ok: boolean;
  error?: string;
  /** Where the meeting transcript came from: the longest meeting note on this phone, or the fixture. */
  inputSource?: 'device-note' | 'synthetic';
  /** Tokens in the formatted prompt, from the model's own tokenizer. */
  promptTokens?: number;
  predictedTokens?: number;
  prefillTokensPerSecond?: number;
  decodeTokensPerSecond?: number;
  totalMs?: number;
  /** True when any thinking came back, in reasoning_content or as a <think> tag. */
  thinkingLeaked?: boolean;
  /** meeting-notes only: the reply parsed as JSON with every required field. */
  jsonValid?: boolean;
  jsonError?: string;
  contextFull?: boolean;
  hitOutputLimit?: boolean;
  output?: string;
}

export interface LlmRunConfig {
  modelId: SpikeModelId;
  nCtx: number;
  gpu: boolean;
  /** Wait this long before loading, so the tester can background the app first. */
  startDelayMs: number;
}

export interface LlmRunResult {
  config: LlmRunConfig;
  device: DeviceInfo | null;
  ok: boolean;
  error?: string;
  startedAt: string;
  loadMs?: number;
  gpuActive?: boolean;
  reasonNoGpu?: string;
  peakBytes?: number;
  baselineBytes?: number;
  minAvailableBytes?: number;
  appStateAtStart: AppStateStatus;
  appStateAtEnd?: AppStateStatus;
  /** The app left the foreground at some point during the run. */
  backgroundedDuringRun: boolean;
  scenarios: LlmScenarioResult[];
}

export function thinkingLeaked(
  result: Pick<NativeCompletionResult, 'text' | 'reasoning_content'>,
): boolean {
  return Boolean(result.reasoning_content?.trim()) || /<think>/i.test(result.text ?? '');
}

export function validateMeetingNotesJson(
  text: string,
): { ok: true } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Not JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Not a JSON object' };
  }
  const notes = parsed as Record<string, unknown>;
  if (typeof notes.summary !== 'string') return { ok: false, error: 'summary is not a string' };
  for (const key of ['keyDiscussionPoints', 'decisions', 'followUps']) {
    const value = notes[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      return { ok: false, error: `${key} is not a string array` };
    }
  }
  const actionItems = notes.actionItems;
  if (
    !Array.isArray(actionItems) ||
    actionItems.some(
      (item) =>
        typeof item !== 'object' ||
        item === null ||
        typeof (item as { text?: unknown }).text !== 'string',
    )
  ) {
    return { ok: false, error: 'actionItems is malformed' };
  }
  return { ok: true };
}

// Keeps whole lines from the start until the estimate passes the budget. The caller re-measures
// with the real tokenizer, so this only has to land near the budget, not on it.
export function takeLinesWithinChars(lines: string[], maxChars: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 2 > maxChars) break;
    kept.push(line);
    used += line.length + 2;
  }
  return kept;
}

function longestDeviceMeetingLines(): string[] | null {
  try {
    let best: string[] | null = null;
    let bestChars = 0;
    for (const note of notesRepository.getAllNotes()) {
      if (note.deletedAt || note.noteType !== 'meeting') continue;
      const segments = notesRepository.getSegments(note.id);
      if (segments.length === 0) continue;
      const lines = formatTranscriptForExport({
        segments,
        speakers: notesRepository.getSpeakers(note.id),
        suppressUnlabeledSpeakerNames: true,
      })
        .split(/\n{2,}/)
        .map((line) => line.trim())
        .filter(Boolean);
      const chars = lines.reduce((sum, line) => sum + line.length, 0);
      if (chars > bestChars) {
        best = lines;
        bestChars = chars;
      }
    }
    return best;
  } catch {
    return null;
  }
}

function syntheticMeetingLines(targetChars: number): string[] {
  const lines: string[] = [];
  let chars = 0;
  for (let round = 1; chars < targetChars; round += 1) {
    for (const line of SYNTHETIC_MEETING_LINES) {
      const text = round === 1 ? line : `${line} (follow-up ${round})`;
      lines.push(text);
      chars += text.length + 2;
      if (chars >= targetChars) break;
    }
  }
  return lines;
}

function baseCompletionParams(input: { system: string; user: string }) {
  return {
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    jinja: true,
    enable_thinking: false,
    // 'auto' separates any thinking into reasoning_content, so a leak is detectable.
    reasoning_format: 'auto' as const,
    top_p: 0.8,
    top_k: 20,
  };
}

async function promptTokenCount(
  context: LlamaContext,
  system: string,
  user: string,
): Promise<number> {
  const formatted = await context.getFormattedChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    null,
    { jinja: true, enable_thinking: false },
  );
  return (await context.tokenize(formatted.prompt)).tokens.length;
}

function summarize(
  name: LlmScenarioName,
  result: NativeCompletionResult,
  startedAt: number,
  promptTokens: number,
  maxTokens: number,
): LlmScenarioResult {
  const output = stripThinkingTags(result.content || result.text || '');
  return {
    name,
    ok: true,
    promptTokens,
    predictedTokens: result.tokens_predicted,
    prefillTokensPerSecond: result.timings?.prompt_per_second,
    decodeTokensPerSecond: result.timings?.predicted_per_second,
    totalMs: Date.now() - startedAt,
    thinkingLeaked: thinkingLeaked(result),
    contextFull: result.context_full,
    hitOutputLimit: result.tokens_predicted >= maxTokens,
    output: output.slice(0, OUTPUT_PREVIEW_CHARS),
  };
}

async function runCleanup(
  context: LlamaContext,
  name: 'cleanup-short' | 'cleanup-long',
  text: string,
): Promise<LlmScenarioResult> {
  const prompt = buildProviderPrompt({ text });
  const promptTokens = await promptTokenCount(context, prompt.systemPrompt, prompt.text);
  const startedAt = Date.now();
  const result = await context.completion({
    ...baseCompletionParams({ system: prompt.systemPrompt, user: prompt.text }),
    n_predict: CLEANUP_OUTPUT_TOKENS,
    temperature: 0.2,
  });
  return summarize(name, result, startedAt, promptTokens, CLEANUP_OUTPUT_TOKENS);
}

async function runMeetingNotes(context: LlamaContext, nCtx: number): Promise<LlmScenarioResult> {
  const system = buildActionSystemPrompt({
    actionPrompt: 'Transform this meeting transcript into concise, actionable meeting notes.',
    inputKind: 'meeting-transcript',
    isDefaultGenerateNotesAction: true,
  });
  const budget = nCtx - NOTES_OUTPUT_TOKENS - NOTES_TEMPLATE_MARGIN_TOKENS;
  const deviceLines = longestDeviceMeetingLines();
  const inputSource = deviceLines ? 'device-note' : 'synthetic';
  // Start from a generous estimate (about 3.5 characters per token), then shrink against the real
  // tokenizer until the prompt fits.
  let maxChars = budget * 4;
  const source = deviceLines ?? syntheticMeetingLines(maxChars);
  let user = '';
  let promptTokens = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 6 && promptTokens > budget; attempt += 1) {
    const lines = takeLinesWithinChars(source, maxChars);
    user = buildMeetingNotesInput({ transcript: lines.join('\n\n') });
    promptTokens = await promptTokenCount(context, system, user);
    maxChars = Math.floor(maxChars * (budget / promptTokens) * 0.97);
  }
  if (promptTokens > budget) {
    return { name: 'meeting-notes', ok: false, inputSource, error: 'Could not fit the transcript' };
  }

  const startedAt = Date.now();
  const result = await context.completion({
    ...baseCompletionParams({ system, user }),
    n_predict: NOTES_OUTPUT_TOKENS,
    temperature: 0.2,
    response_format: { type: 'json_schema', json_schema: { schema: MEETING_NOTES_JSON_SCHEMA } },
  });
  const summary = summarize('meeting-notes', result, startedAt, promptTokens, NOTES_OUTPUT_TOKENS);
  const validation = validateMeetingNotesJson(
    stripThinkingTags(result.content || result.text || ''),
  );
  return {
    ...summary,
    inputSource,
    jsonValid: validation.ok,
    jsonError: validation.ok ? undefined : validation.error,
  };
}

async function runScenario(
  name: LlmScenarioName,
  run: () => Promise<LlmScenarioResult>,
): Promise<LlmScenarioResult> {
  try {
    return await run();
  } catch (error) {
    return { name, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runLlmBenchmark(
  config: LlmRunConfig,
  onProgress: (message: string) => void,
): Promise<LlmRunResult> {
  const result: LlmRunResult = {
    config,
    device: await ParakeetASR.deviceInfo().catch(() => null),
    ok: false,
    startedAt: new Date().toISOString(),
    appStateAtStart: AppState.currentState,
    backgroundedDuringRun: AppState.currentState !== 'active',
    scenarios: [],
  };
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state !== 'active') result.backgroundedDuringRun = true;
  });

  let context: LlamaContext | null = null;
  let sampling = false;
  try {
    if (config.startDelayMs > 0) {
      onProgress(`Starting in ${Math.round(config.startDelayMs / 1000)} s…`);
      await new Promise((resolve) => setTimeout(resolve, config.startDelayMs));
    }

    // Production will never hold an ASR engine and the LLM at once, so neither does the benchmark.
    onProgress('Releasing speech models…');
    await LocalWhisperService.cleanup();
    await LocalParakeetService.cleanup();

    await ParakeetASR.startMemorySampling();
    sampling = true;

    if ((await getSpikeModelSize(config.modelId)) == null) {
      throw new Error(`${spikeModel(config.modelId).label} is not downloaded.`);
    }
    onProgress(
      `Loading ${spikeModel(config.modelId).label} (${config.gpu ? 'Metal' : 'CPU'}, n_ctx ${config.nCtx})…`,
    );
    const loadStartedAt = Date.now();
    context = await initLlama({
      model: modelPath(config.modelId).replace(/^file:\/\//, ''),
      n_ctx: config.nCtx,
      n_batch: 512,
      n_ubatch: 512,
      n_parallel: 1,
      n_gpu_layers: config.gpu ? 99 : 0,
      no_gpu_devices: !config.gpu,
      flash_attn_type: config.gpu ? 'auto' : 'off',
      use_mlock: false,
      use_mmap: true,
    });
    result.loadMs = Date.now() - loadStartedAt;
    result.gpuActive = context.gpu;
    result.reasonNoGpu = context.reasonNoGPU || undefined;

    const loaded = context;
    onProgress('Cleanup (short)…');
    result.scenarios.push(
      await runScenario('cleanup-short', () =>
        runCleanup(loaded, 'cleanup-short', CLEANUP_SHORT_FIXTURE),
      ),
    );
    await loaded.clearCache();

    onProgress('Cleanup (long)…');
    result.scenarios.push(
      await runScenario('cleanup-long', () =>
        runCleanup(loaded, 'cleanup-long', CLEANUP_LONG_FIXTURE),
      ),
    );
    // Hybrid (recurrent + attention) models such as Qwen3.5 can only clear their state whole.
    await loaded.clearCache();

    onProgress('Meeting notes…');
    result.scenarios.push(
      await runScenario('meeting-notes', () => runMeetingNotes(loaded, config.nCtx)),
    );
    result.ok = result.scenarios.every((scenario) => scenario.ok);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (context) await context.release().catch(() => undefined);
    if (sampling) {
      const memory = await ParakeetASR.stopMemorySampling().catch(() => null);
      if (memory) {
        result.peakBytes = memory.peakBytes;
        result.baselineBytes = memory.baselineBytes;
        result.minAvailableBytes = memory.minAvailableBytes;
      }
    }
    result.appStateAtEnd = AppState.currentState;
    appStateSubscription.remove();
  }
  return result;
}

// What the tester copies back to the team: every measurement, but no model output, since the
// meeting-notes input can be one of the tester's own meetings.
export function resultsForSharing(results: LlmRunResult[]): string {
  return JSON.stringify(
    results.map((run) => ({
      ...run,
      scenarios: run.scenarios.map(({ output: _output, ...scenario }) => scenario),
    })),
    null,
    2,
  );
}
