import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, ActivityIndicator, Pressable } from 'react-native';
import { Text } from '@/components/ui/Text';
import { OnboardingShell } from '@/components/onboarding/OnboardingShell';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { getStepProgress, useOnboardingStore } from '@/store/useOnboardingStore';
import { useConfigStore } from '@/store/useConfigStore';
import { useModelDownloadStore, type LocalModelKey } from '@/store/useModelDownloadStore';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
import { getLocalModelCatalog, type LocalModelCatalogEntry } from '@/lib/localModelCatalog';
import { getPrivateModeUnavailableMessage } from '@/lib/privateMode';
import { SlowDownloadSheet } from './SlowDownloadSheet';

// Reuse the language step's progress so the conditional step doesn't jump the bar.
const PROGRESS_ID = 'language';
// Show the "taking a while?" sheet only if the download is still under halfway
// after this delay — fast connections finish first and never see it.
const SLOW_AFTER_MS = 8000;
const SLOW_BELOW = 0.5;

function formatModelSize(bytes: number): string {
  return `~${Math.round(bytes / (1024 * 1024))} MB`;
}

export function PrivateDownloadStep() {
  const goNext = useOnboardingStore((s) => s.goNext);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const downloads = useModelDownloadStore((s) => s.downloads);
  const startDownload = useModelDownloadStore((s) => s.startDownload);
  const cancelDownload = useModelDownloadStore((s) => s.cancelDownload);

  const available = LocalTranscriptionService.isAvailable();
  // The language step just ran, so the selection is settled; pick the model it routes to.
  const languages = useMemo(() => getPreferredTranscriptionLanguages(), []);
  const [recommended, setRecommended] = useState<LocalModelCatalogEntry | null>(null);
  const [sheetVisible, setSheetVisible] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    LocalTranscriptionService.getAvailability()
      .then((availability) => {
        if (cancelled) return;
        // Catalog is sorted recommended-first; on platforms without Parakeet the first
        // visible entry is the Whisper fallback.
        setRecommended(getLocalModelCatalog(languages, availability)[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setRecommended(null);
      });
    return () => {
      cancelled = true;
    };
  }, [available, languages]);

  const modelKey: LocalModelKey | null = recommended?.key ?? null;
  const download = modelKey ? downloads[modelKey] : null;
  const status = download?.status ?? 'idle';
  const progress = download?.progress ?? 0;
  const error = download?.error;

  useEffect(() => {
    if (
      available &&
      modelKey &&
      !recommended?.downloaded &&
      !startedRef.current &&
      status === 'idle'
    ) {
      startedRef.current = true;
      startDownload(modelKey);
    }
  }, [available, modelKey, recommended?.downloaded, status, startDownload]);

  useEffect(() => {
    if (!available || !modelKey) return;
    const timer = setTimeout(() => {
      const entry = useModelDownloadStore.getState().downloads[modelKey];
      if (entry.status === 'downloading' && entry.progress < SLOW_BELOW) setSheetVisible(true);
    }, SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [available, modelKey]);

  const continuePrivate = useCallback(async () => {
    // The CTA is gated on status === 'completed', which means the model is on disk (and for
    // Parakeet, prepared). If it ever isn't, the Home toggle's readiness check re-prompts a
    // download — so we trust the store's completed status here rather than re-checking disk.
    await updateConfig({ defaultMode: 'private' });
    await goNext();
  }, [updateConfig, goNext]);

  const switchToCloud = useCallback(async () => {
    await updateConfig({ defaultMode: 'cloud' });
    await goNext();
  }, [updateConfig, goNext]);

  const continueCloudKeepDownloading = useCallback(async () => {
    setSheetVisible(false);
    // Download keeps running in the background (store not reset).
    await switchToCloud();
  }, [switchToCloud]);

  // The auto-start effect only fires once, from idle, so a retry has to start the download itself.
  const retryDownload = useCallback(() => {
    if (modelKey) startDownload(modelKey);
  }, [modelKey, startDownload]);

  const switchToCloudStop = useCallback(async () => {
    // A failed attempt still has its partial download staged; cancelling reclaims it.
    if (modelKey && (status === 'downloading' || status === 'preparing' || status === 'error')) {
      await cancelDownload(modelKey);
    }
    await switchToCloud();
  }, [cancelDownload, modelKey, status, switchToCloud]);

  if (!available) {
    return (
      <OnboardingShell
        progress={getStepProgress(PROGRESS_ID)}
        title="Private mode needs the full app"
        subtitle={getPrivateModeUnavailableMessage()}
        ctaLabel="Use Cloud instead"
        onCta={switchToCloud}
      >
        <View className="flex-1 items-center justify-center">
          <View className="h-28 w-28 items-center justify-center rounded-2xl bg-secondarySystemGroupedBackground">
            <SystemIcon name="lock.slash.fill" mdName="LockOpen" size={48} color="secondaryLabel" />
          </View>
        </View>
      </OnboardingShell>
    );
  }

  const done = recommended?.downloaded === true || status === 'completed';
  const preparing = status === 'preparing';
  const percent = done ? 100 : Math.round(progress * 100);
  const modelTitle = recommended?.title ?? 'On-device model';
  const modelSize = recommended ? formatModelSize(recommended.sizeBytes) : '';

  return (
    <>
      <OnboardingShell
        progress={getStepProgress(PROGRESS_ID)}
        title="Set up Private mode"
        titleAccent="Private"
        subtitle={`Private runs entirely on your device. It needs a one-time ${
          modelSize || 'model'
        } download, matched to your languages.`}
        ctaLabel={done ? 'Continue with Private' : 'Continue · available when ready'}
        ctaDisabled={!done}
        onCta={continuePrivate}
        secondaryCtaLabel={done ? 'Use Cloud instead' : "Don't use Private — switch to Cloud"}
        onSecondaryCta={switchToCloudStop}
      >
        <View className="flex-1 pt-2">
          <View className="rounded-xl border border-separator bg-secondarySystemGroupedBackground p-4">
            <View className="flex-row items-center gap-3">
              <View className="h-9 w-9 items-center justify-center rounded-lg bg-quaternarySystemFill">
                <SystemIcon
                  name={done ? 'checkmark' : 'arrow.down'}
                  mdName={done ? 'Check' : 'Download'}
                  size={18}
                  color={done ? 'systemGreen' : 'brand'}
                />
              </View>
              <View className="flex-1">
                <Text className="text-[16px] font-semibold text-label">{modelTitle}</Text>
                <Text className="mt-0.5 text-[13px] text-secondaryLabel">
                  {recommended
                    ? `${recommended.languagesNote} · ${modelSize}`
                    : 'Choosing the best model…'}
                </Text>
              </View>
              {done ? (
                <View className="rounded-md bg-systemGreen/15 px-2 py-0.5">
                  <Text className="text-[11px] font-semibold text-systemGreen">Ready</Text>
                </View>
              ) : null}
            </View>

            <View className="mt-4 h-1.5 overflow-hidden rounded-full bg-quaternarySystemFill">
              <View
                className={`h-full rounded-full ${done ? 'bg-systemGreen' : 'bg-brand'}`}
                style={{ width: `${done || preparing ? 100 : Math.max(percent, 6)}%` }}
              />
            </View>
            <View className="mt-2 flex-row items-center justify-between">
              {preparing ? (
                <View className="flex-row items-center gap-1.5">
                  <ActivityIndicator size="small" />
                  <Text className="text-[12px] text-secondaryLabel">
                    Preparing model for your device… (one time)
                  </Text>
                </View>
              ) : (
                <Text className="text-[12px] text-secondaryLabel">
                  {done ? 'Downloaded · stored on device' : 'Downloading…'}
                </Text>
              )}
              {!preparing ? (
                <Text className="text-[12px] text-secondaryLabel">{percent}%</Text>
              ) : null}
            </View>

            {status === 'error' && error ? (
              <Text className="mt-2 text-[12px] text-systemRed">{error}</Text>
            ) : null}
            {status === 'error' ? (
              <Pressable
                onPress={retryDownload}
                hitSlop={8}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                className="mt-1 self-start"
              >
                <Text className="text-[12px] font-medium text-brand">Try again</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </OnboardingShell>

      <SlowDownloadSheet
        visible={sheetVisible}
        onContinueCloud={continueCloudKeepDownloading}
        onKeepWaiting={() => setSheetVisible(false)}
      />
    </>
  );
}
