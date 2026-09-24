import React, { useEffect, useState, useCallback } from 'react';
import { View, ScrollView, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useRouter } from 'expo-router';
import { LocalWhisperService } from '@/services/transcription/LocalWhisperService';
import { LocalParakeetService } from '@/services/transcription/LocalParakeetService';
import { LocalTranscriptionService } from '@/services/transcription/LocalTranscriptionService';
import { getPreferredTranscriptionLanguages } from '@/lib/transcriptionLanguage';
import { getLocalModelCatalog, type LocalModelCatalogEntry } from '@/lib/localModelCatalog';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useModelDownloadStore, type LocalModelKey } from '@/store/useModelDownloadStore';
import { confirmDestructive } from '@/lib/alerts';
import { safeHaptics } from '@/lib/utils';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function ModelDownloadScreen() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<LocalModelCatalogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isAvailable, setIsAvailable] = useState(false);
  // Bytes a failed or interrupted Parakeet download left staged, per key (absent = none).
  const [stagedBytes, setStagedBytes] = useState<Partial<Record<LocalModelKey, number>>>({});
  const downloads = useModelDownloadStore((state) => state.downloads);
  const completedCount = useModelDownloadStore((state) => state.completedCount);
  const startDownload = useModelDownloadStore((state) => state.startDownload);
  const cancelDownload = useModelDownloadStore((state) => state.cancelDownload);
  const anyBusy = Object.values(downloads).some(
    (entry) => entry.status === 'downloading' || entry.status === 'preparing',
  );

  const loadCatalog = useCallback(async () => {
    try {
      setIsLoading(true);
      const available = LocalTranscriptionService.isAvailable();
      setIsAvailable(available);
      if (available) {
        const availability = await LocalTranscriptionService.getAvailability();
        setCatalog(getLocalModelCatalog(getPreferredTranscriptionLanguages(), availability));
      }
    } catch {
      Alert.alert('Error', 'Failed to load models');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog, completedCount]);

  // Staging only changes between transfers, and every such change (a download ending in error,
  // cancel or completion; a partial download being cleared) also changes `downloads`.
  useEffect(() => {
    if (anyBusy) return;
    let stale = false;
    Promise.all([
      LocalParakeetService.stagedDownloadBytes('v2'),
      LocalParakeetService.stagedDownloadBytes('v3'),
    ])
      .then(([v2, v3]) => {
        if (!stale) setStagedBytes({ 'parakeet-v2': v2, 'parakeet-v3': v3 });
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [downloads, anyBusy]);

  const handleDownload = useCallback(
    async (key: LocalModelKey) => {
      safeHaptics('light');
      await startDownload(key);
    },
    [startDownload],
  );

  const handleDelete = useCallback(
    (entry: LocalModelCatalogEntry) => {
      confirmDestructive(
        'Delete Model',
        `Are you sure you want to delete "${entry.title}"?`,
        async () => {
          try {
            if (entry.key === 'whisper-base') {
              await LocalWhisperService.deleteModel('base');
            } else {
              await LocalParakeetService.deleteModel(entry.key === 'parakeet-v2' ? 'v2' : 'v3');
            }
            safeHaptics('warning');
            await loadCatalog();
          } catch {
            Alert.alert('Error', 'Failed to delete model');
          }
        },
      );
    },
    [loadCatalog],
  );

  // The delete button only exists for installed models; this is the only way to get the storage
  // back once the user gives up on a Parakeet download.
  const handleClearPartial = useCallback(
    (entry: LocalModelCatalogEntry, bytes: number) => {
      confirmDestructive(
        'Clear Partial Download',
        `This removes the ${formatBytes(bytes)} saved from an interrupted "${entry.title}" download. The next download starts from the beginning.`,
        async () => {
          // Nothing is transferring for this key, so cancelling only reclaims the staged files and
          // resets the row's error state.
          await cancelDownload(entry.key);
          safeHaptics('warning');
        },
        { destructiveLabel: 'Clear' },
      );
    },
    [cancelDownload],
  );

  if (!isAvailable && !isLoading) {
    return (
      <View className="flex-1 items-center justify-center bg-systemBackground px-6">
        <View
          style={{ borderCurve: 'continuous' }}
          className="w-full rounded-[10px] bg-secondarySystemGroupedBackground p-5"
        >
          <Text className="mb-2 text-center text-base font-semibold text-label">
            On-device transcription is not available
          </Text>
          <Text className="text-center text-sm text-secondaryLabel">
            Build the app with native modules enabled to use local models.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-systemBackground"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
    >
      <Text className="mb-4 px-1 text-sm text-secondaryLabel">
        Download models for offline transcription. The recommended model matches your dictation
        language.
      </Text>

      {isLoading ? (
        <View className="items-center justify-center py-12">
          <ActivityIndicator size="large" />
          <Text className="mt-3 text-sm text-secondaryLabel">Loading models…</Text>
        </View>
      ) : (
        <View className="gap-3">
          {catalog.map((model) => {
            const download = downloads[model.key];
            const isDownloading = download.status === 'downloading' && !model.downloaded;
            const isPreparing = download.status === 'preparing' && !model.downloaded;
            const downloadPercent = Math.round(download.progress * 100);
            const staged = stagedBytes[model.key] ?? 0;
            // Staged bytes are only re-read between transfers, so the label is stale while any
            // download runs.
            const canClearPartial = staged > 0 && !model.downloaded && !anyBusy;

            return (
              <View
                key={model.key}
                style={{ borderCurve: 'continuous' }}
                className="rounded-[10px] bg-secondarySystemGroupedBackground p-4"
              >
                <View className="flex-row items-start justify-between">
                  <View className="flex-1 pr-3">
                    <View className="mb-1.5 flex-row items-center gap-2">
                      <Text className="text-[17px] font-semibold text-label">{model.title}</Text>
                      {model.recommended ? (
                        <View
                          style={{ borderCurve: 'continuous' }}
                          className="rounded-md bg-brand/15 px-2 py-0.5"
                        >
                          <Text className="text-[11px] font-semibold text-brand">Recommended</Text>
                        </View>
                      ) : null}
                      {model.downloaded ? (
                        <View
                          style={{ borderCurve: 'continuous' }}
                          className="rounded-md bg-systemGreen/15 px-2 py-0.5"
                        >
                          <Text className="text-[11px] font-semibold text-systemGreen">
                            Downloaded
                          </Text>
                        </View>
                      ) : null}
                    </View>
                    <Text className="text-sm text-secondaryLabel">{model.description}</Text>
                    <Text className="mt-0.5 text-xs text-tertiaryLabel">
                      {model.languagesNote} · {formatBytes(model.sizeBytes)}
                    </Text>

                    {isDownloading ? (
                      <View className="mt-3">
                        <View className="h-1.5 overflow-hidden rounded-full bg-quaternarySystemFill">
                          <View
                            className="h-full rounded-full bg-brand"
                            style={{ width: `${Math.max(downloadPercent, 8)}%` }}
                          />
                        </View>
                        <Text className="mt-1.5 text-right text-xs text-secondaryLabel">
                          {downloadPercent}%
                        </Text>
                      </View>
                    ) : null}

                    {isPreparing ? (
                      <View className="mt-3 flex-row items-center gap-2">
                        <ActivityIndicator size="small" />
                        <Text className="text-xs text-secondaryLabel">
                          Preparing model for your device… (one time)
                        </Text>
                      </View>
                    ) : null}

                    {download.status === 'error' && download.error ? (
                      <Text className="mt-2 text-xs text-systemRed">{download.error}</Text>
                    ) : null}

                    {canClearPartial ? (
                      <>
                        <Text className="mt-2 text-xs text-secondaryLabel">
                          {`${formatBytes(staged)} saved from an earlier attempt will be reused.`}
                        </Text>
                        <Pressable
                          onPress={() => handleClearPartial(model, staged)}
                          hitSlop={8}
                          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                          className="mt-1 self-start"
                        >
                          <Text className="text-xs font-medium text-systemRed">
                            {`Clear partial download (${formatBytes(staged)})`}
                          </Text>
                        </Pressable>
                      </>
                    ) : null}
                  </View>

                  {model.downloaded ? (
                    <Pressable
                      onPress={() => handleDelete(model)}
                      style={({ pressed }) => ({
                        opacity: pressed ? 0.85 : 1,
                        transform: [{ scale: pressed ? 0.97 : 1 }],
                        borderCurve: 'continuous',
                      })}
                      className="h-9 w-9 items-center justify-center rounded-lg bg-systemRed/15"
                    >
                      <SystemIcon name="trash" mdName="Trash2" size={17} color="systemRed" />
                    </Pressable>
                  ) : (
                    <Pressable
                      onPress={() => handleDownload(model.key)}
                      disabled={anyBusy}
                      style={({ pressed }) => ({
                        opacity: anyBusy ? 0.5 : pressed ? 0.85 : 1,
                        transform: [{ scale: pressed ? 0.97 : 1 }],
                        borderCurve: 'continuous',
                      })}
                      className="h-9 w-9 items-center justify-center rounded-lg bg-brand"
                    >
                      <SystemIcon
                        name="arrow.down.circle.fill"
                        mdName="Download"
                        size={18}
                        color="#FFF"
                      />
                    </Pressable>
                  )}
                </View>
              </View>
            );
          })}
        </View>
      )}

      <View
        style={{ borderCurve: 'continuous' }}
        className="mt-5 rounded-[10px] bg-secondarySystemGroupedBackground p-4"
      >
        <Text className="mb-1.5 text-sm font-semibold text-label">Which model do I need?</Text>
        <Text className="text-xs text-secondaryLabel leading-[18px]">
          One model is enough — private mode picks the right engine from your dictation language.
          Parakeet is the fastest and most accurate for English (v2) and 25 European languages (v3).
          Whisper base covers everything else, including auto-detect. Downloads stay on your device.
        </Text>
        <Pressable
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
            } else {
              router.replace('/(account)');
            }
          }}
          style={({ pressed }) => ({
            opacity: pressed ? 0.85 : 1,
            transform: [{ scale: pressed ? 0.98 : 1 }],
            borderCurve: 'continuous',
          })}
          className="mt-3 items-center rounded-lg bg-tertiarySystemFill py-2.5"
        >
          <Text className="text-sm font-medium text-label">Done</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
