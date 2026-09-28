import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useNotesStore } from '@/store/useNotesStore';
import { confirmDestructive } from '@/lib/alerts';
import { safeHaptics } from '@/lib/utils';
import { Sentry } from '@/lib/sentry';

// The diarizer's native module downloads in one shot with no progress callback and no delete API,
// so this screen models simple lifecycle states rather than mirroring the Whisper progress bar.
type ModelStatus = 'checking' | 'unavailable' | 'idle' | 'downloading' | 'ready' | 'error';

export default function DiarizationModelScreen() {
  const router = useRouter();
  const isDiarizerAvailable = useNotesStore((state) => state.isDiarizerAvailable);
  const isDiarizerModelReady = useNotesStore((state) => state.isDiarizerModelReady);
  const downloadDiarizerModel = useNotesStore((state) => state.downloadDiarizerModel);
  const deleteDiarizerModel = useNotesStore((state) => state.deleteDiarizerModel);
  const [status, setStatus] = useState<ModelStatus>('checking');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      if (!(await isDiarizerAvailable())) {
        setStatus('unavailable');
        return;
      }
      setStatus((await isDiarizerModelReady()) ? 'ready' : 'idle');
    } catch (caught) {
      setStatus('unavailable');
      Sentry.captureException(caught, { tags: { feature: 'diarization-model-settings' } });
    }
  }, [isDiarizerAvailable, isDiarizerModelReady]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDownload = useCallback(async () => {
    safeHaptics('light');
    setError(null);
    setStatus('downloading');
    try {
      await downloadDiarizerModel();
      safeHaptics('success');
      setStatus('ready');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Download failed');
      setStatus('error');
      Sentry.captureException(caught, { tags: { feature: 'diarization-model-settings' } });
    }
  }, [downloadDiarizerModel]);

  const handleDelete = useCallback(() => {
    confirmDestructive(
      'Delete Speaker Model',
      'Remove the on-device speaker model? Meeting transcription will need it downloaded again.',
      async () => {
        try {
          await deleteDiarizerModel();
          safeHaptics('warning');
          setError(null);
          setStatus('idle');
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'Delete failed');
          setStatus('error');
          Sentry.captureException(caught, { tags: { feature: 'diarization-model-settings' } });
        }
      },
    );
  }, [deleteDiarizerModel]);

  if (status === 'checking') {
    return (
      <View className="flex-1 items-center justify-center bg-systemBackground px-6">
        <ActivityIndicator size="large" />
        <Text className="mt-3 text-sm text-secondaryLabel">Checking model…</Text>
      </View>
    );
  }

  if (status === 'unavailable') {
    return (
      <View className="flex-1 items-center justify-center bg-systemBackground px-6">
        <View
          style={{ borderCurve: 'continuous' }}
          className="w-full rounded-[10px] bg-secondarySystemGroupedBackground p-5"
        >
          <Text className="mb-2 text-center text-base font-semibold text-label">
            Not available on this device
          </Text>
          <Text className="text-center text-sm text-secondaryLabel">
            Meeting transcription runs on the Apple Neural Engine and needs iOS 17+ in a development
            or production build (not Expo Go).
          </Text>
        </View>
      </View>
    );
  }

  const isReady = status === 'ready';
  const isDownloading = status === 'downloading';

  return (
    <ScrollView
      className="flex-1 bg-systemBackground"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
    >
      <Text className="mb-4 px-1 text-sm text-secondaryLabel">
        Required to label who&apos;s speaking in meeting recordings.
      </Text>

      <View
        style={{ borderCurve: 'continuous' }}
        className="rounded-[10px] bg-secondarySystemGroupedBackground p-4"
      >
        <View className="flex-row items-start justify-between">
          <View className="flex-1 pr-3">
            <View className="mb-1.5 flex-row items-center gap-2">
              <Text className="text-[17px] font-semibold text-label">Speaker model</Text>
              {isReady ? (
                <View
                  style={{ borderCurve: 'continuous' }}
                  className="rounded-md bg-systemGreen/15 px-2 py-0.5"
                >
                  <Text className="text-[11px] font-semibold text-systemGreen">Downloaded</Text>
                </View>
              ) : null}
            </View>
            <Text className="text-sm text-secondaryLabel">
              Separates and labels speakers, fully on-device.
            </Text>
            <Text className="mt-0.5 text-xs text-tertiaryLabel">~100 MB · one-time download</Text>

            {isDownloading ? (
              <View className="mt-3 flex-row items-center gap-2">
                <ActivityIndicator size="small" />
                <Text className="text-xs text-secondaryLabel">Downloading…</Text>
              </View>
            ) : null}

            {status === 'error' && error ? (
              <Text className="mt-2 text-xs text-systemRed">{error}</Text>
            ) : null}
          </View>

          {isReady ? (
            <Pressable
              onPress={handleDelete}
              style={({ pressed }) => ({
                opacity: pressed ? 0.85 : 1,
                transform: [{ scale: pressed ? 0.97 : 1 }],
                borderCurve: 'continuous',
              })}
              className="h-9 w-9 items-center justify-center rounded-lg bg-systemRed/15"
            >
              <SystemIcon name="trash" mdName="Trash2" size={17} color="systemRed" />
            </Pressable>
          ) : isDownloading ? (
            <View className="h-9 w-9 items-center justify-center">
              <ActivityIndicator size="small" />
            </View>
          ) : (
            <Pressable
              onPress={handleDownload}
              style={({ pressed }) => ({
                opacity: pressed ? 0.85 : 1,
                transform: [{ scale: pressed ? 0.97 : 1 }],
                borderCurve: 'continuous',
              })}
              className="h-9 w-9 items-center justify-center rounded-lg bg-brand"
            >
              <SystemIcon name="arrow.down.circle.fill" mdName="Download" size={18} color="#FFF" />
            </Pressable>
          )}
        </View>
      </View>

      <View
        style={{ borderCurve: 'continuous' }}
        className="mt-5 rounded-[10px] bg-secondarySystemGroupedBackground p-4"
      >
        <Text className="mb-1.5 text-sm font-semibold text-label">On-device & private</Text>
        <Text className="text-xs leading-[18px] text-secondaryLabel">
          Speaker separation runs entirely on your device — recordings never leave it. Download once
          and it stays available even if you leave this screen.
        </Text>
        <Pressable
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace('/(account)');
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
