import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/lib/utils';
import { confirmDestructive } from '@/lib/alerts';
import { Sentry } from '@/lib/sentry';
import { ParakeetASR, type DeviceInfo } from '../../modules/parakeet-asr/src';
import {
  deleteSpikeModel,
  downloadSpikeModel,
  getSpikeModelSize,
  resultsForSharing,
  runLlmBenchmark,
  spikeModel,
  SPIKE_MODELS,
  type LlmRunConfig,
  type LlmRunResult,
  type LlmScenarioResult,
  type SpikeModel,
  type SpikeModelId,
} from '@/lib/benchmark/runLlmBenchmark';

// Dev-only spike screen for the candidate on-device LLMs through llama.rn (Phase 0 of
// docs/superpowers/plans/2026-10-07-mobile-local-llm-qwen.md). Reached by the
// /(account)/llm-benchmark route only.

const CONTEXT_SIZES = [4096, 16384] as const;
const BACKGROUND_TEST_DELAY_MS = 15_000;

const mb = (bytes?: number) => (bytes == null ? '—' : `${(bytes / 1024 / 1024).toFixed(0)} MB`);
const ms = (value?: number) => (value == null ? '—' : `${(value / 1000).toFixed(1)} s`);
const tps = (value?: number) => (value == null ? '—' : `${value.toFixed(1)} tok/s`);
const yesNo = (value?: boolean) => (value == null ? '—' : value ? 'Yes' : 'No');

function runLabel(config: LlmRunConfig): string {
  const delay = config.startDelayMs > 0 ? ' · background test' : '';
  return `${spikeModel(config.modelId).label} · ${config.gpu ? 'Metal' : 'CPU'} · n_ctx ${config.nCtx}${delay}`;
}

interface ModelState {
  size: number | null;
  progress: number | null;
  error?: string;
}

const EMPTY_MODEL: ModelState = { size: null, progress: null };

export default function LlmBenchmarkScreen() {
  const available = ParakeetASR.isAvailable();
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [models, setModels] = useState<Partial<Record<SpikeModelId, ModelState>>>({});
  const [modelId, setModelId] = useState<SpikeModelId>(SPIKE_MODELS[0].id);
  const [gpu, setGpu] = useState(true);
  const [nCtx, setNCtx] = useState<number>(16384);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [results, setResults] = useState<LlmRunResult[]>([]);

  const updateModel = useCallback((id: SpikeModelId, patch: Partial<ModelState>) => {
    setModels((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_MODEL), ...patch } }));
  }, []);

  const refreshModel = useCallback(
    async (id: SpikeModelId) => {
      updateModel(id, { size: await getSpikeModelSize(id).catch(() => null) });
    },
    [updateModel],
  );

  useEffect(() => {
    if (!available) return;
    ParakeetASR.deviceInfo()
      .then(setDevice)
      .catch(() => setDevice(null));
    SPIKE_MODELS.forEach((model) => refreshModel(model.id));
  }, [available, refreshModel]);

  const handleDownload = useCallback(
    async (id: SpikeModelId) => {
      safeHaptics('light');
      updateModel(id, { progress: 0, error: undefined });
      try {
        await downloadSpikeModel(id, (fraction) => updateModel(id, { progress: fraction }));
        safeHaptics('success');
      } catch (error) {
        Sentry.captureException(error, { tags: { feature: 'llm-benchmark' } });
        updateModel(id, { error: error instanceof Error ? error.message : 'Download failed' });
      } finally {
        updateModel(id, { progress: null });
        await refreshModel(id);
      }
    },
    [refreshModel, updateModel],
  );

  const handleDelete = useCallback(
    (id: SpikeModelId) => {
      confirmDestructive(
        'Delete model',
        `Remove the ${spikeModel(id).label} weights from this device?`,
        async () => {
          await deleteSpikeModel(id).catch(() => undefined);
          safeHaptics('warning');
          await refreshModel(id);
        },
      );
    },
    [refreshModel],
  );

  const handleRun = useCallback(
    async (startDelayMs: number) => {
      safeHaptics('medium');
      setRunning(true);
      setProgress('');
      try {
        const result = await runLlmBenchmark({ modelId, nCtx, gpu, startDelayMs }, setProgress);
        setResults((prev) => [result, ...prev]);
        safeHaptics(result.ok ? 'success' : 'warning');
      } catch (error) {
        Sentry.captureException(error, { tags: { feature: 'llm-benchmark' } });
      } finally {
        setRunning(false);
        setProgress('');
      }
    },
    [gpu, modelId, nCtx],
  );

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(resultsForSharing(results));
    safeHaptics('success');
  }, [results]);

  if (!available) {
    return (
      <View className="flex-1 items-center justify-center bg-systemBackground px-6">
        <Text className="text-center text-sm text-secondaryLabel">
          The on-device LLM benchmark needs a native iOS build on a physical device.
        </Text>
      </View>
    );
  }

  const downloading = SPIKE_MODELS.some((model) => models[model.id]?.progress != null);
  const canRun = models[modelId]?.size != null && !running && !downloading;

  return (
    <ScrollView
      className="flex-1 bg-systemBackground"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
    >
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
          Meeting notes use your longest meeting note when there is one, otherwise a built-in
          sample. Copied results never include model output.
        </Text>
      </Card>

      <SectionTitle>Models</SectionTitle>
      {SPIKE_MODELS.map((model) => (
        <ModelRow
          key={model.id}
          model={model}
          state={models[model.id] ?? EMPTY_MODEL}
          disabled={running || downloading}
          onDownload={() => handleDownload(model.id)}
          onDelete={() => handleDelete(model.id)}
        />
      ))}

      <SectionTitle>Settings</SectionTitle>
      <Card>
        <Text className="mb-2 text-xs text-secondaryLabel">Model</Text>
        <View className="mb-3 flex-row flex-wrap gap-2">
          {SPIKE_MODELS.map((model) => (
            <Chip
              key={model.id}
              label={model.label}
              on={modelId === model.id}
              onPress={() => setModelId(model.id)}
            />
          ))}
        </View>
        <Text className="mb-2 text-xs text-secondaryLabel">Backend</Text>
        <View className="mb-3 flex-row gap-2">
          <Chip label="Metal" on={gpu} onPress={() => setGpu(true)} />
          <Chip label="CPU" on={!gpu} onPress={() => setGpu(false)} />
        </View>
        <Text className="mb-2 text-xs text-secondaryLabel">Context (n_ctx)</Text>
        <View className="flex-row gap-2">
          {CONTEXT_SIZES.map((size) => (
            <Chip
              key={size}
              label={String(size)}
              on={nCtx === size}
              onPress={() => setNCtx(size)}
            />
          ))}
        </View>
      </Card>

      <RunButton
        label={running ? 'Running…' : 'Run benchmark'}
        icon="play.fill"
        mdIcon="Play"
        disabled={!canRun}
        busy={running}
        onPress={() => handleRun(0)}
      />
      <RunButton
        label={`Background test (starts in ${BACKGROUND_TEST_DELAY_MS / 1000} s)`}
        icon="moon.fill"
        mdIcon="Moon"
        disabled={!canRun}
        secondary
        onPress={() => handleRun(BACKGROUND_TEST_DELAY_MS)}
      />
      <Text className="mt-1 px-1 text-xs text-tertiaryLabel">
        For the background test, tap it, then go to the Home Screen before it starts. Come back
        after about a minute.
      </Text>
      {running && progress ? (
        <Text className="mt-2 text-center text-xs text-secondaryLabel">{progress}</Text>
      ) : null}

      {results.length > 0 ? (
        <>
          <View className="mt-5 flex-row items-center justify-between px-1">
            <Text className="text-[13px] font-semibold uppercase tracking-wide text-secondaryLabel">
              Results
            </Text>
            <Pressable onPress={handleCopy}>
              <Text className="text-[13px] text-brand">Copy as JSON</Text>
            </Pressable>
          </View>
          {results.map((result) => (
            <RunCard key={result.startedAt} result={result} />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

function ModelRow({
  model,
  state,
  disabled,
  onDownload,
  onDelete,
}: {
  model: SpikeModel;
  state: ModelState;
  disabled: boolean;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const status =
    state.progress != null
      ? `Downloading · ${Math.round(state.progress * 100)}%`
      : state.size != null
        ? `Downloaded · ${mb(state.size)}`
        : `Not downloaded · about ${model.approxSize}`;
  return (
    <Card>
      <View className="flex-row items-center justify-between">
        <View className="flex-1 pr-3">
          <Text className="text-[15px] text-label">{model.label} (Q4_K_M)</Text>
          <Text className="mt-0.5 text-xs text-tertiaryLabel">{status}</Text>
          {state.error ? (
            <Text className="mt-0.5 text-xs text-systemRed">{state.error}</Text>
          ) : null}
        </View>
        {state.progress != null ? (
          <ActivityIndicator size="small" />
        ) : state.size != null ? (
          <Pressable
            onPress={onDelete}
            disabled={disabled}
            style={{ borderCurve: 'continuous' }}
            className="h-9 w-9 items-center justify-center rounded-lg bg-systemRed/15"
          >
            <SystemIcon name="trash" mdName="Trash2" size={17} color="systemRed" />
          </Pressable>
        ) : (
          <Pressable
            onPress={onDownload}
            disabled={disabled}
            style={{ borderCurve: 'continuous', opacity: disabled ? 0.4 : 1 }}
            className="h-9 w-9 items-center justify-center rounded-lg bg-brand"
          >
            <SystemIcon name="arrow.down.circle.fill" mdName="Download" size={18} color="#FFF" />
          </Pressable>
        )}
      </View>
    </Card>
  );
}

function RunCard({ result }: { result: LlmRunResult }) {
  return (
    <Card>
      <Text className="text-[15px] font-semibold text-label">{runLabel(result.config)}</Text>
      {result.error ? <Text className="mt-1 text-xs text-systemRed">{result.error}</Text> : null}
      <View className="mt-2 flex-row flex-wrap">
        <Metric label="Peak memory" value={mb(result.peakBytes)} highlight />
        <Metric label="Min headroom" value={mb(result.minAvailableBytes)} highlight />
        <Metric label="Model load" value={ms(result.loadMs)} />
        <Metric label="Metal active" value={yesNo(result.gpuActive)} />
        <Metric label="Backgrounded" value={yesNo(result.backgroundedDuringRun)} />
        <Metric label="Baseline" value={mb(result.baselineBytes)} />
      </View>
      {result.reasonNoGpu ? (
        <Text className="mt-1 text-xs text-tertiaryLabel">No Metal: {result.reasonNoGpu}</Text>
      ) : null}
      {result.scenarios.map((scenario) => (
        <ScenarioRow key={scenario.name} scenario={scenario} />
      ))}
    </Card>
  );
}

function ScenarioRow({ scenario }: { scenario: LlmScenarioResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="mt-3 border-t border-separator pt-3">
      <Text className="text-[14px] font-semibold text-label">
        {scenario.name}
        {scenario.inputSource ? ` · ${scenario.inputSource}` : ''}
      </Text>
      {!scenario.ok ? (
        <Text className="mt-1 text-xs text-systemRed">{scenario.error ?? 'Failed'}</Text>
      ) : (
        <>
          <View className="mt-1 flex-row flex-wrap">
            <Metric label="Total" value={ms(scenario.totalMs)} highlight />
            <Metric label="Prompt tokens" value={String(scenario.promptTokens ?? '—')} />
            <Metric label="Prefill" value={tps(scenario.prefillTokensPerSecond)} />
            <Metric label="Decode" value={tps(scenario.decodeTokensPerSecond)} />
            <Metric label="Thinking leaked" value={yesNo(scenario.thinkingLeaked)} />
            <Metric label="Hit output limit" value={yesNo(scenario.hitOutputLimit)} />
            {scenario.jsonValid != null ? (
              <Metric
                label="Valid JSON"
                value={scenario.jsonValid ? 'Yes' : `No (${scenario.jsonError})`}
              />
            ) : null}
          </View>
          <Pressable onPress={() => setExpanded((value) => !value)} className="mt-1">
            <Text className="text-[13px] text-brand">
              {expanded ? 'Hide output' : 'Show output'}
            </Text>
          </Pressable>
          {expanded ? (
            <Text className="mt-2 text-[13px] leading-[19px] text-secondaryLabel">
              {scenario.output?.trim() || '(empty)'}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

function RunButton({
  label,
  icon,
  mdIcon,
  disabled,
  busy,
  secondary,
  onPress,
}: {
  label: string;
  icon: string;
  mdIcon: 'Play' | 'Moon';
  disabled: boolean;
  busy?: boolean;
  secondary?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
        borderCurve: 'continuous',
      })}
      className={`mt-3 h-12 flex-row items-center justify-center gap-2 rounded-xl ${secondary ? 'bg-tertiarySystemFill' : 'bg-brand'}`}
    >
      {busy ? (
        <ActivityIndicator size="small" color="#FFF" />
      ) : (
        <SystemIcon name={icon} mdName={mdIcon} size={16} color={secondary ? 'label' : '#FFF'} />
      )}
      <Text className={`text-[16px] font-semibold ${secondary ? 'text-label' : 'text-white'}`}>
        {label}
      </Text>
    </Pressable>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{ borderCurve: 'continuous' }}
      className={`rounded-full px-3 py-1.5 ${on ? 'bg-brand' : 'bg-tertiarySystemFill'}`}
    >
      <Text className={`text-[13px] font-medium ${on ? 'text-white' : 'text-label'}`}>{label}</Text>
    </Pressable>
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
