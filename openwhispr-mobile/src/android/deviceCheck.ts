import * as FileSystem from 'expo-file-system/legacy';
import { AndroidDictation, type DeviceProfile } from '../../modules/android-dictation/src';
import { LocalSpeechModel } from './LocalSpeechModel';
import { LocalTextModel, selectedTextModel, type AndroidTextModelId } from './LocalTextModel';
import { selectedSpeechModel, type AndroidSpeechModelId } from './speechSelection';
import { modelReady } from './models';
import { speechModelSupportsLanguages } from './speechCapabilities';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
import { buildProviderPrompt } from '@/services/reasoning/buildProviderPrompt';
import { buildDictationHints } from '@/lib/dictationHints';
import { getActiveCustomCleanupPrompt } from '@/store/useCustomPromptsStore';
import { useConfigStore } from '@/store/useConfigStore';
import type { KeyboardTone } from '@/types';
import i18n from './strings';

export interface BenchmarkSelection {
  speech: AndroidSpeechModelId;
  text: AndroidTextModelId;
  languages: string[];
  language?: string;
  customPrompt?: string;
  customDictionary: string[];
  tone?: KeyboardTone;
}
export interface LocalBenchmark {
  selection: BenchmarkSelection;
  durationMs: number;
  speechMs: number;
  cleanupMs: number;
  totalMs: number;
  transcript: string;
  cleanedText: string;
  before: DeviceProfile | null;
  after: DeviceProfile | null;
}
export type BenchmarkStage = 'preparingSample' | 'processing' | 'cleanup';
export function readDeviceProfile(): DeviceProfile | null {
  try {
    return AndroidDictation!.getDeviceProfile();
  } catch {
    return null;
  }
}
export function snapshotBenchmark(): BenchmarkSelection {
  const config = useConfigStore.getState().config;
  const languages = getPreferredTranscriptionLanguages();
  return {
    speech: selectedSpeechModel(),
    text: selectedTextModel(),
    languages,
    language: languages.length === 1 && languages[0] !== 'auto' ? languages[0] : undefined,
    customPrompt: getActiveCustomCleanupPrompt(),
    customDictionary: [...buildDictationHints(false)],
    tone:
      config?.androidStyleTones?.[config.androidStyleContext ?? 'personal'] ?? config?.keyboardTone,
  };
}
export function deviceGuidance(
  profile: DeviceProfile | null,
  result?: LocalBenchmark | null,
): string {
  if (!profile) return 'deviceInfoUnavailable';
  if (profile.emulator) return 'deviceEmulator';
  if ((profile.thermalStatus ?? 0) >= 3) return 'deviceHot';
  if (profile.lowMemory) return 'deviceMemoryPressure';
  if (result && (result.after?.lowMemory || (result.after?.thermalStatus ?? 0) >= 3))
    return 'deviceTestPressure';
  if (result && result.totalMs > result.durationMs) return 'deviceSlow';
  if (result) return 'deviceReviewAccuracy';
  return profile.lowRamDevice ? 'deviceLowRam' : 'deviceTestFirst';
}
function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw Object.assign(new Error(i18n.t('cancelled')), { name: 'AbortError' });
}
export async function validateBenchmark(
  selection: BenchmarkSelection,
  signal: AbortSignal,
): Promise<void> {
  assertActive(signal);
  if (!speechModelSupportsLanguages(selection.speech, selection.languages))
    throw new Error(
      i18n.t(selection.speech === 'parakeet-v3' ? 'unsupportedLanguage' : 'moonshineEnglishOnly'),
    );
  const ready = await Promise.all([modelReady(selection.speech), modelReady(selection.text)]);
  assertActive(signal);
  if (!ready.every(Boolean)) throw new Error(i18n.t('benchmarkDownloads'));
}
export async function runLocalBenchmark(
  uri: string,
  selection: BenchmarkSelection,
  signal: AbortSignal,
  stage: (value: BenchmarkStage) => void,
): Promise<LocalBenchmark> {
  await validateBenchmark(selection, signal);
  const before = readDeviceProfile();
  if (before?.lowMemory || (before?.thermalStatus ?? 0) >= 3)
    throw new Error(i18n.t(before?.lowMemory ? 'deviceMemoryPressure' : 'deviceHot'));
  let decodedUri: string | undefined;
  try {
    stage('preparingSample');
    const started = Date.now();
    const decodeId = AndroidDictation!.prepareSampleDecode();
    const cancelDecode = () => AndroidDictation!.cancelSampleDecode(decodeId);
    signal.addEventListener('abort', cancelDecode, { once: true });
    // Preparing the native handle is synchronous, so even an immediate abort
    // reaches the decoder before its asynchronous work starts.
    if (signal.aborted) cancelDecode();
    const sample = await AndroidDictation!
      .decodeSampleAudio(uri, decodeId)
      .finally(() => signal.removeEventListener('abort', cancelDecode));
    decodedUri = sample.uri;
    assertActive(signal);
    if (!sample.durationMs || sample.durationMs > 30000) throw new Error(i18n.t('benchmarkLength'));
    stage('processing');
    const speechStart = Date.now();
    const speech = await LocalSpeechModel.transcribe(sample.uri, {
      language: selection.language,
      androidModel: selection.speech,
      signal,
    });
    assertActive(signal);
    if (!speech.text.trim()) throw new Error(i18n.t('noSpeech'));
    const speechMs = Date.now() - speechStart;
    stage('cleanup');
    const cleanupStart = Date.now();
    const request = {
      text: speech.text,
      language: selection.language,
      customDictionary: selection.customDictionary,
      customPrompt: selection.customPrompt,
      tone: selection.tone,
      signal,
      maxTokens: 900,
    };
    const cleaned = await LocalTextModel.processText(
      { ...request, ...buildProviderPrompt(request) },
      selection.text,
    );
    assertActive(signal);
    return {
      selection,
      durationMs: sample.durationMs,
      speechMs,
      cleanupMs: Date.now() - cleanupStart,
      totalMs: Date.now() - started,
      transcript: speech.text,
      cleanedText: cleaned.text,
      before,
      after: readDeviceProfile(),
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes('SAMPLE_TOO_LONG'))
      throw new Error(i18n.t('benchmarkLength'));
    throw error;
  } finally {
    if (decodedUri && FileSystem.cacheDirectory && decodedUri.startsWith(FileSystem.cacheDirectory))
      await FileSystem.deleteAsync(decodedUri, { idempotent: true }).catch(() => undefined);
  }
}
