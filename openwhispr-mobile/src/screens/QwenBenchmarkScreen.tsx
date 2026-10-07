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
  deleteQwenSpikeModel,
  downloadQwenSpikeModel,
  getQwenSpikeModelSize,
  resultsForSharing,
  runQwenBenchmark,
  type QwenRunConfig,
  type QwenRunResult,
  type QwenScenarioResult,
} from '@/lib/benchmark/runQwenBenchmark';

// Dev-only spike screen for Qwen3.5-2B through llama.rn (Phase 0 of
// docs/superpowers/plans/2026-10-07-mobile-local-llm-qwen.md). Reached by the
// /(account)/qwen-benchmark route only.

const CONTEXT_SIZES = [4096, 16384] as const;
const BACKGROUND_TEST_DELAY_MS = 15_000;

const mb = (bytes?: number) => (bytes == null ? '—' : `${(bytes / 1024 / 1024).toFixed(0)} MB`);
const ms = (value?: number) => (value == null ? '—' : `${(value / 1000).toFixed(1)} s`);
const tps = (value?: number) => (value == null ? '—' : `${value.toFixed(1)} tok/s`);
const yesNo = (value?: boolean) => (value == null ? '—' : value ? 'Yes' : 'No');

function runLabel(config: QwenRunConfig): string {
  const delay = config.startDelayMs > 0 ? ' · background test' : '';
  return `${config.gpu ? 'Metal' : 'CPU'} · n_ctx ${config.nCtx}${delay}`;
}

export default function QwenBenchmarkScreen() {
  const available = ParakeetASR.isAvailable();
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [modelSize, setModelSize] = useState<number | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [gpu, setGpu] = useState(true);
  const [nCtx, setNCtx] = useState<number>(16384);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [results, setResults] = useState<QwenRunResult[]>([]);

  const refreshModel = useCallback(async () => {
    setModelSize(await getQwenSpikeModelSize().catch(() => null));
  }, []);

  useEffect(() => {
    if (!available) return;
    ParakeetASR.deviceInfo()
      .then(setDevice)
      .catch(() => setDevice(null));
    refreshModel();
  }, [available, refreshModel]);

  const handleDownload = useCallback(async () => {
    safeHaptics('light');
    setDownloadProgress(0);
    try {
      await downloadQwenSpikeModel(setDownloadProgress);
      safeHaptics('success');
    } catch (error) {
      Sentry.captureException(error, { tags: { feature: 'qwen-benchmark' } });
      setProgress(error instanceof Error ? error.message : 'Download failed');
    } finally {
      setDownloadProgress(null);
      await refreshModel();
    }
  }, [refreshModel]);

  const handleDelete = useCallback(() => {
    confirmDestructive(
      'Delete model',
      'Remove the Qwen3.5 2B weights from this device?',
      async () => {
        await deleteQwenSpikeModel().catch(() => undefined);
        safeHaptics('warning');
        await refreshModel();
      },
    );
  }, [refreshModel]);

  const handleRun = useCallback(
    async (startDelayMs: number) => {
      safeHaptics('medium');
      setRunning(true);
      setProgress('');
      try {
        const result = await runQwenBenchmark({ nCtx, gpu, startDelayMs }, setProgress);
        setResults((prev) => [result, ...prev]);
        safeHaptics(result.ok ? 'success' : 'warning');
      } catch (error) {
        Sentry.captureException(error, { tags: { feature: 'qwen-benchmark' } });
      } finally {
        setRunning(false);
        setProgress('');
      }
    },
    [gpu, nCtx],
  );

  const handleCopy = useCallback(async () => {
    await Clipboard.setStringAsync(resultsForSharing(results));
    safeHaptics('success');
  }, [results]);

  if (!available) {
    return (
      <View className="flex-1 items-center justify-center bg-systemBackground px-6">
        <Text className="text-center text-sm text-secondaryLabel">
          The Qwen benchmark needs a native iOS build on a physical device.
        </Text>
      </View>
    );
  }

  const canRun = modelSize != null && !running && downloadProgress == null;

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

      <SectionTitle>Model</SectionTitle>
      <Card>
        <View className="flex-row items-center justify-between">
          <View className="flex-1 pr-3">
            <Text className="text-[15px] text-label">Qwen3.5 2B (Q4_K_M)</Text>
            <Text className="mt-0.5 text-xs text-tertiaryLabel">
              {downloadProgress != null
                ? `Downloading · ${Math.round(downloadProgress * 100)}%`
                : modelSize != null
                  ? `Downloaded · ${mb(modelSize)}`
                  : 'Not downloaded · about 1.3 GB'}
            </Text>
          </View>
          {downloadProgress != null ? (
            <ActivityIndicator size="small" />
          ) : modelSize != null ? (
            <Pressable
              onPress={handleDelete}
              disabled={running}
              style={{ borderCurve: 'continuous' }}
              className="h-9 w-9 items-center justify-center rounded-lg bg-systemRed/15"
            >
              <SystemIcon name="trash" mdName="Trash2" size={17} color="systemRed" />
            </Pressable>
          ) : (
            <Pressable
              onPress={handleDownload}
              style={{ borderCurve: 'continuous' }}
              className="h-9 w-9 items-center justify-center rounded-lg bg-brand"
            >
              <SystemIcon name="arrow.down.circle.fill" mdName="Download" size={18} color="#FFF" />
            </Pressable>
          )}
        </View>
      </Card>

      <SectionTitle>Settings</SectionTitle>
      <Card>
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

function RunCard({ result }: { result: QwenRunResult }) {
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

function ScenarioRow({ scenario }: { scenario: QwenScenarioResult }) {
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
