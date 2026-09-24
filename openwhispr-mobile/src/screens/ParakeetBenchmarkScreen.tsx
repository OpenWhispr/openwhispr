import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { useAudioRecorder } from 'expo-audio';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/lib/utils';
import { confirmDestructive } from '@/lib/alerts';
import { Sentry } from '@/lib/sentry';
import { getDefaultRecorderOptions, getExpoAudioModule } from '@/utils/expoAudio';
import { LocalWhisperService } from '@/services/transcription/LocalWhisperService';
import { LocalParakeetService } from '@/services/transcription/LocalParakeetService';
import { ParakeetASR, type DeviceInfo } from '../../modules/parakeet-asr/src';
import {
  runBenchmark,
  ENGINE_LABEL,
  type BenchEngine,
  type EngineRunResult,
} from '@/lib/benchmark/runParakeetBenchmark';

// Dev-only spike screen: benchmark Parakeet (v3-int8, v2) vs Whisper base on this device. The two numbers
// that decide the migration are warm RTF and peak memory — see docs/plans/PARAKEET-LOCAL-ASR.md.

const ALL_ENGINES: BenchEngine[] = ['parakeet-v3', 'parakeet-v2', 'whisper-base'];
const SAMPLE_PATH = `${FileSystem.documentDirectory}parakeet-bench/sample.wav`;

const mb = (bytes?: number) => (bytes == null ? '—' : `${(bytes / 1024 / 1024).toFixed(0)} MB`);
const ms = (value?: number) => (value == null ? '—' : `${Math.round(value)} ms`);
const rtf = (value?: number) => (value == null ? '—' : `${value.toFixed(1)}×`);
const secs = (value?: number) => (value == null ? '—' : `${value.toFixed(1)}s`);

interface ModelState {
  downloaded: boolean;
  sizeBytes?: number;
  busy: boolean;
}

const EMPTY_MODEL: ModelState = { downloaded: false, busy: false };

export default function ParakeetBenchmarkScreen() {
  const available = ParakeetASR.isAvailable();
  const recorderOptions = getDefaultRecorderOptions();
  const recorder = useAudioRecorder(recorderOptions);

  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [selected, setSelected] = useState<Set<BenchEngine>>(new Set(ALL_ENGINES));
  const [models, setModels] = useState<Record<BenchEngine, ModelState>>({
    'parakeet-v3': EMPTY_MODEL,
    'parakeet-v2': EMPTY_MODEL,
    'whisper-base': EMPTY_MODEL,
  });

  const [isRecording, setIsRecording] = useState(false);
  const [clipUri, setClipUri] = useState<string | null>(null);
  const [clipSeconds, setClipSeconds] = useState<number | null>(null);
  const recordStartedAt = useRef<number>(0);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string>('');
  const [results, setResults] = useState<EngineRunResult[]>([]);
  const [expanded, setExpanded] = useState<Set<BenchEngine>>(new Set());

  const refreshModels = useCallback(async () => {
    if (!available) return;
    try {
      const [v3, v3Size, v2, v2Size, whisperModels] = await Promise.all([
        ParakeetASR.isModelDownloaded('v3'),
        ParakeetASR.modelSizeBytes('v3'),
        ParakeetASR.isModelDownloaded('v2'),
        ParakeetASR.modelSizeBytes('v2'),
        LocalWhisperService.getAvailableModels(),
      ]);
      const base = whisperModels.find((m) => m.name === 'base');
      setModels({
        'parakeet-v3': { downloaded: v3, sizeBytes: v3Size, busy: false },
        'parakeet-v2': { downloaded: v2, sizeBytes: v2Size, busy: false },
        'whisper-base': { downloaded: !!base, sizeBytes: base?.size, busy: false },
      });
    } catch (error) {
      Sentry.captureException(error, { tags: { feature: 'parakeet-benchmark' } });
    }
  }, [available]);

  useEffect(() => {
    if (!available) return;
    ParakeetASR.deviceInfo()
      .then(setDevice)
      .catch(() => setDevice(null));
    refreshModels();
  }, [available, refreshModels]);

  const setBusy = (engine: BenchEngine, busy: boolean) =>
    setModels((prev) => ({ ...prev, [engine]: { ...prev[engine], busy } }));

  const handleDownload = useCallback(
    async (engine: BenchEngine) => {
      safeHaptics('light');
      setBusy(engine, true);
      try {
        if (engine === 'whisper-base') {
          await LocalWhisperService.downloadModel('base');
        } else {
          await LocalParakeetService.downloadModel(engine === 'parakeet-v3' ? 'v3' : 'v2');
        }
        safeHaptics('success');
      } catch (error) {
        Sentry.captureException(error, { tags: { feature: 'parakeet-benchmark' } });
      } finally {
        await refreshModels();
      }
    },
    [refreshModels],
  );

  const handleDelete = useCallback(
    (engine: BenchEngine) => {
      confirmDestructive(
        'Delete model',
        `Remove ${ENGINE_LABEL[engine]} weights from this device?`,
        async () => {
          setBusy(engine, true);
          try {
            if (engine === 'whisper-base') {
              await LocalWhisperService.deleteModel('base');
            } else {
              await ParakeetASR.deleteModel(engine === 'parakeet-v3' ? 'v3' : 'v2');
            }
            safeHaptics('warning');
          } catch (error) {
            Sentry.captureException(error, { tags: { feature: 'parakeet-benchmark' } });
          } finally {
            await refreshModels();
          }
        },
      );
    },
    [refreshModels],
  );

  const startRecording = useCallback(async () => {
    const expoAudio = getExpoAudioModule();
    if (!expoAudio) return;
    try {
      const { granted } = await expoAudio.AudioModule.requestRecordingPermissionsAsync();
      if (!granted) throw new Error('Microphone permission not granted');
      await expoAudio.AudioModule.setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        interruptionMode: 'mixWithOthers',
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
        allowsBackgroundRecording: false,
      }).catch(() => undefined);

      if (recorder.isRecording) await recorder.stop().catch(() => undefined);
      await recorder.prepareToRecordAsync(recorderOptions);
      await recorder.record();
      recordStartedAt.current = Date.now();
      setIsRecording(true);
      safeHaptics('light');
    } catch (error) {
      Sentry.captureException(error, { tags: { feature: 'parakeet-benchmark' } });
    }
  }, [recorder, recorderOptions]);

  const stopRecording = useCallback(async () => {
    try {
      await recorder.stop();
      const uri = recorder.uri;
      setIsRecording(false);
      if (!uri) return;
      // Persist to a stable path so every engine (and every re-run) transcribes the identical bytes.
      await FileSystem.makeDirectoryAsync(`${FileSystem.documentDirectory}parakeet-bench`, {
        intermediates: true,
      }).catch(() => undefined);
      await FileSystem.deleteAsync(SAMPLE_PATH, { idempotent: true }).catch(() => undefined);
      await FileSystem.copyAsync({ from: uri, to: SAMPLE_PATH });
      setClipUri(SAMPLE_PATH);
      setClipSeconds((Date.now() - recordStartedAt.current) / 1000);
      setResults([]);
      safeHaptics('success');
    } catch (error) {
      Sentry.captureException(error, { tags: { feature: 'parakeet-benchmark' } });
    }
  }, [recorder]);

  const canRun = !!clipUri && selected.size > 0 && !running && !isRecording;

  const handleRun = useCallback(async () => {
    if (!clipUri) return;
    safeHaptics('medium');
    setRunning(true);
    setResults([]);
    setProgress('Starting…');
    try {
      const engines = ALL_ENGINES.filter((engine) => selected.has(engine));
      const output = await runBenchmark(clipUri, engines, {
        warmRuns: 3,
        onProgress: setProgress,
      });
      setResults(output);
      safeHaptics('success');
    } catch (error) {
      Sentry.captureException(error, { tags: { feature: 'parakeet-benchmark' } });
    } finally {
      setRunning(false);
      setProgress('');
      await refreshModels();
    }
  }, [clipUri, selected, refreshModels]);

  const toggleEngine = (engine: BenchEngine) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(engine)) next.delete(engine);
      else next.add(engine);
      return next;
    });

  const toggleExpanded = (engine: BenchEngine) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(engine)) next.delete(engine);
      else next.add(engine);
      return next;
    });

  if (!available) {
    return (
      <View className="flex-1 items-center justify-center bg-systemBackground px-6">
        <View
          style={{ borderCurve: 'continuous' }}
          className="w-full rounded-[10px] bg-secondarySystemGroupedBackground p-5"
        >
          <Text className="mb-2 text-center text-base font-semibold text-label">
            Not available here
          </Text>
          <Text className="text-center text-sm text-secondaryLabel">
            The Parakeet benchmark needs a native iOS 17+ build (not Expo Go). Run with{' '}
            <Text className="font-semibold text-label">expo run:ios</Text> on a physical device.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-systemBackground"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
    >
      {/* Device header */}
      <Card>
        <Text className="text-[13px] font-semibold uppercase tracking-wide text-secondaryLabel">
          Device
        </Text>
        <Text className="mt-1 text-[15px] text-label">
          {device
            ? `${device.model} · ${mb(device.totalMemoryBytes)} RAM · iOS ${device.osVersion}`
            : 'Reading…'}
        </Text>
        <Text className="mt-1 text-xs text-tertiaryLabel">
          Warm RTF ≥ ~25–30× here suggests older devices still clear ~5×. Watch peak memory vs a
          ~1.3–1.4 GB budget on 4 GB iPhones.
        </Text>
      </Card>

      {/* Models */}
      <SectionTitle>Models</SectionTitle>
      {ALL_ENGINES.map((engine) => (
        <ModelRow
          key={engine}
          label={ENGINE_LABEL[engine]}
          state={models[engine]}
          onDownload={() => handleDownload(engine)}
          onDelete={() => handleDelete(engine)}
        />
      ))}

      {/* Engines to run */}
      <SectionTitle>Run engines</SectionTitle>
      <Card>
        <View className="flex-row flex-wrap gap-2">
          {ALL_ENGINES.map((engine) => {
            const on = selected.has(engine);
            return (
              <Pressable
                key={engine}
                onPress={() => toggleEngine(engine)}
                style={{ borderCurve: 'continuous' }}
                className={`rounded-full px-3 py-1.5 ${on ? 'bg-brand' : 'bg-tertiarySystemFill'}`}
              >
                <Text className={`text-[13px] font-medium ${on ? 'text-white' : 'text-label'}`}>
                  {ENGINE_LABEL[engine]}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      {/* Recording */}
      <SectionTitle>Sample clip</SectionTitle>
      <Card>
        <View className="flex-row items-center justify-between">
          <View className="flex-1 pr-3">
            <Text className="text-[15px] text-label">
              {clipUri ? `Recorded clip · ~${secs(clipSeconds ?? undefined)}` : 'No clip yet'}
            </Text>
            <Text className="mt-0.5 text-xs text-tertiaryLabel">
              16 kHz mono WAV — the same file feeds every engine.
            </Text>
          </View>
          <Pressable
            onPress={isRecording ? stopRecording : startRecording}
            style={({ pressed }) => ({
              opacity: pressed ? 0.85 : 1,
              transform: [{ scale: pressed ? 0.97 : 1 }],
              borderCurve: 'continuous',
            })}
            className={`h-11 flex-row items-center gap-2 rounded-xl px-4 ${isRecording ? 'bg-systemRed' : 'bg-brand'}`}
          >
            <SystemIcon
              name={isRecording ? 'stop.fill' : 'mic.fill'}
              mdName={isRecording ? 'Square' : 'Mic'}
              size={16}
              color="#FFF"
            />
            <Text className="text-[15px] font-semibold text-white">
              {isRecording ? 'Stop' : 'Record'}
            </Text>
          </Pressable>
        </View>
      </Card>

      {/* Run */}
      <Pressable
        onPress={handleRun}
        disabled={!canRun}
        style={({ pressed }) => ({
          opacity: !canRun ? 0.4 : pressed ? 0.85 : 1,
          transform: [{ scale: pressed && canRun ? 0.98 : 1 }],
          borderCurve: 'continuous',
        })}
        className="mt-5 h-12 flex-row items-center justify-center gap-2 rounded-xl bg-brand"
      >
        {running ? (
          <ActivityIndicator size="small" color="#FFF" />
        ) : (
          <SystemIcon name="play.fill" mdName="Play" size={16} color="#FFF" />
        )}
        <Text className="text-[16px] font-semibold text-white">
          {running ? 'Running…' : 'Run benchmark'}
        </Text>
      </Pressable>
      {running && progress ? (
        <Text className="mt-2 text-center text-xs text-secondaryLabel">{progress}</Text>
      ) : null}

      {/* Results */}
      {results.length > 0 ? (
        <>
          <SectionTitle>Results</SectionTitle>
          {results.map((result) => (
            <ResultCard
              key={result.engine}
              result={result}
              expanded={expanded.has(result.engine)}
              onToggle={() => toggleExpanded(result.engine)}
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <View
      style={{ borderCurve: 'continuous' }}
      className="mb-2 rounded-[10px] bg-secondarySystemGroupedBackground p-4"
    >
      {children}
    </View>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text className="mb-2 mt-5 px-1 text-[13px] font-semibold uppercase tracking-wide text-secondaryLabel">
      {children}
    </Text>
  );
}

function ModelRow({
  label,
  state,
  onDownload,
  onDelete,
}: {
  label: string;
  state: ModelState;
  onDownload: () => void;
  onDelete: () => void;
}) {
  return (
    <Card>
      <View className="flex-row items-center justify-between">
        <View className="flex-1 pr-3">
          <Text className="text-[15px] text-label">{label}</Text>
          <Text className="mt-0.5 text-xs text-tertiaryLabel">
            {state.downloaded ? `Downloaded · ${mb(state.sizeBytes)}` : 'Not downloaded'}
          </Text>
        </View>
        {state.busy ? (
          <ActivityIndicator size="small" />
        ) : state.downloaded ? (
          <Pressable
            onPress={onDelete}
            style={{ borderCurve: 'continuous' }}
            className="h-9 w-9 items-center justify-center rounded-lg bg-systemRed/15"
          >
            <SystemIcon name="trash" mdName="Trash2" size={17} color="systemRed" />
          </Pressable>
        ) : (
          <Pressable
            onPress={onDownload}
            style={{ borderCurve: 'continuous' }}
            className="h-9 w-9 items-center justify-center rounded-lg bg-brand"
          >
            <SystemIcon name="arrow.down.circle.fill" mdName="Download" size={18} color="#FFF" />
          </Pressable>
        )}
      </View>
    </Card>
  );
}

function Metric({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <View className="w-1/2 py-1 pr-2">
      <Text className="text-[11px] uppercase tracking-wide text-tertiaryLabel">{label}</Text>
      <Text className={`text-[15px] ${highlight ? 'font-bold text-label' : 'text-label'}`}>
        {value}
      </Text>
    </View>
  );
}

function ResultCard({
  result,
  expanded,
  onToggle,
}: {
  result: EngineRunResult;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!result.ok) {
    return (
      <Card>
        <Text className="text-[15px] font-semibold text-label">{result.label}</Text>
        <Text className="mt-1 text-xs text-systemRed">{result.error ?? 'Failed'}</Text>
      </Card>
    );
  }
  return (
    <Card>
      <Text className="text-[15px] font-semibold text-label">{result.label}</Text>
      <View className="mt-2 flex-row flex-wrap">
        <Metric label="RTF (warm)" value={rtf(result.rtf)} highlight />
        <Metric label="Peak memory" value={mb(result.peakBytes)} highlight />
        <Metric label="Warm infer" value={ms(result.warmMedianInferMs)} />
        <Metric label="Cold infer" value={ms(result.coldInferMs)} />
        <Metric label="Model load" value={ms(result.loadMs)} />
        <Metric label="Model size" value={mb(result.modelSizeBytes)} />
        <Metric label="Clip length" value={secs(result.audioSeconds)} />
        <Metric label="Mem headroom" value={mb(result.minAvailableBytes)} />
      </View>
      <Pressable onPress={onToggle} className="mt-2 flex-row items-center gap-1">
        <SystemIcon
          name={expanded ? 'chevron.up' : 'chevron.down'}
          mdName={expanded ? 'ChevronUp' : 'ChevronDown'}
          size={13}
          color="secondaryLabel"
        />
        <Text className="text-[13px] text-brand">
          {expanded ? 'Hide transcript' : 'Show transcript'}
        </Text>
      </Pressable>
      {expanded ? (
        <Text className="mt-2 text-[13px] leading-[19px] text-secondaryLabel">
          {result.text?.trim() || '(empty)'}
        </Text>
      ) : null}
    </Card>
  );
}
