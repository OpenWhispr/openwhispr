import { useEffect, useRef, useState } from 'react';
import { Alert, Animated, Pressable, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { ANDROID_MODELS, cancelAndroidDownload, downloadAndroidModel, modelReady } from '../models';
import i18n from '../strings';
import { home } from '../home/kit';
import { Badge, ListRow, settings, showToast } from './kit';
import { DownloadRing, type RingPhase } from './DownloadRing';
import { formatSize, modelName, type MODEL_ROWS } from './modelCatalog';
import { settingsT, useSettingsT } from './strings';
import { speakerModelRemovedByUser } from '../liveSpeakers/speakerModel';

type Row = (typeof MODEL_ROWS)[number];

/** Starts a download; a cancel says so at the bottom, any other failure is a dialog. */
export function startModelDownload(id: Row['id']) {
  if (id === 'meeting-speakers') speakerModelRemovedByUser(false);
  downloadAndroidModel(id).catch((error: Error) => {
    if (error.message === i18n.t('downloadCancelled'))
      showToast(settingsT('downloadCancelled'), 'neutral');
    else Alert.alert(settingsT('downloadProblem'), error.message, [{ text: settingsT('ok') }]);
  });
}

/** "about 40 s" from how fast the bytes have come in so far. */
export function useTimeLeft(progress: number | undefined): number | undefined {
  const start = useRef<{ at: number; fraction: number } | null>(null);
  if (progress === undefined) start.current = null;
  else if (!start.current) start.current = { at: Date.now(), fraction: progress };
  if (progress === undefined || !start.current) return undefined;
  const elapsed = (Date.now() - start.current.at) / 1000;
  const gained = progress - start.current.fraction;
  if (elapsed < 1.5 || gained <= 0) return undefined;
  return ((1 - progress) * elapsed) / gained;
}

/**
 * One on-device model, with the V1 Ring: Download crossfades into a ring that fills, spins while
 * setting up, then draws a check with one CONFIRM haptic. `onSettled` says how a download ended:
 * true once the model is on the phone, false when it was cancelled or failed.
 */
export function ModelRow({
  row,
  ready,
  inUse,
  progress,
  dimmed,
  reduceMotion,
  onUse,
  onSettled,
}: {
  row: Row;
  ready: boolean;
  inUse: boolean;
  progress: number | undefined;
  dimmed: boolean;
  reduceMotion: boolean;
  onUse?: () => void;
  onSettled?: (ready: boolean) => void;
}) {
  const t = useSettingsT();
  // Between the last byte and the readiness check the ring keeps spinning; never "Download".
  const [ending, setEnding] = useState<'checking' | 'done' | null>(null);
  const downloading = progress !== undefined;
  const wasDownloading = useRef(downloading);
  const timeLeft = useTimeLeft(progress);
  const total = ANDROID_MODELS[row.id].bytes;

  useEffect(() => {
    if (wasDownloading.current && !downloading) {
      setEnding('checking');
      modelReady(row.id)
        .catch(() => false)
        .then((ok) => {
          setEnding(ok ? 'done' : null);
          if (ok)
            Haptics.performAndroidHapticsAsync(Haptics.AndroidHaptics.Confirm).catch(
              () => undefined,
            );
          onSettled?.(ok);
        });
    }
    wasDownloading.current = downloading;
  }, [downloading, row.id, onSettled]);

  const phase: RingPhase | null = downloading
    ? progress >= 0.98
      ? 'setting-up'
      : 'downloading'
    : ending === 'done'
      ? 'done'
      : ending === 'checking'
        ? 'setting-up'
        : null;

  // "Download" and the ring trade places in 150 ms; the badge leaves once the model is here.
  const ringShown = useRef(new Animated.Value(phase ? 1 : 0)).current;
  const badge = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(ringShown, {
      toValue: phase ? 1 : 0,
      duration: reduceMotion ? 0 : 150,
      useNativeDriver: true,
    }).start();
  }, [phase, reduceMotion, ringShown]);
  useEffect(() => {
    if (phase === 'done')
      Animated.timing(badge, {
        toValue: 0,
        duration: reduceMotion ? 0 : 200,
        useNativeDriver: true,
      }).start();
  }, [phase, reduceMotion, badge]);

  const name = modelName(row.id);
  const lineText = row.line ? `${t(row.line)} · ${formatSize(total)}` : formatSize(total);
  const subtitle =
    phase === 'downloading'
      ? [
          t('sizeOf', {
            done: formatSize(progress! * total).replace(/ (MB|GB)$/, ''),
            total: formatSize(total),
          }),
          timeLeft !== undefined &&
            (timeLeft < 90
              ? t('aboutSeconds', { count: Math.max(1, Math.round(timeLeft)) })
              : t('aboutMinutes', { count: Math.round(timeLeft / 60) })),
        ]
          .filter(Boolean)
          .join(' · ')
      : phase === 'setting-up'
        ? t('settingUp')
        : lineText;
  const selected = inUse || phase === 'done';
  const showBadge = row.recommended && (!ready || phase === 'done');

  const trailing = (
    <View style={{ minWidth: 28, height: 28, justifyContent: 'center', alignItems: 'flex-end' }}>
      {!ready && !ending && (
        <Animated.Text
          style={[
            settings.rowValue,
            {
              color: dimmed ? home.tertiary : home.accent,
              opacity: ringShown.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            },
          ]}
        >
          {t('download')}
        </Animated.Text>
      )}
      {phase && (
        <Animated.View style={{ position: 'absolute', right: 0, opacity: ringShown }}>
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityLabel={t('cancelDownload', { model: name })}
            disabled={phase !== 'downloading'}
            hitSlop={10}
            onPress={() => {
              cancelAndroidDownload(row.id).catch(() => undefined);
            }}
          >
            <DownloadRing phase={phase} progress={progress ?? 1} reduceMotion={reduceMotion} />
          </Pressable>
        </Animated.View>
      )}
      {!phase && inUse && (
        <SystemIcon name="checkmark" mdName="Check" size={22} color={home.accent} />
      )}
    </View>
  );

  return (
    <ListRow
      icon={
        row.kind === 'diarization' ? 'UsersRound' : row.kind === 'text' ? 'Sparkles' : 'AudioLines'
      }
      title={name}
      accessibilityLabel={!ready && !phase ? t('downloadModel', { model: name }) : undefined}
      badge={
        showBadge ? (
          <Animated.View style={{ opacity: badge }}>
            <Badge label={t('recommended')} onSelected={selected} />
          </Animated.View>
        ) : undefined
      }
      subtitle={
        <Text style={[settings.subtitle, settings.tabular]} accessibilityLiveRegion="polite">
          {subtitle}
        </Text>
      }
      selected={selected}
      dimmed={dimmed}
      trailing={trailing}
      onPress={
        dimmed || phase
          ? undefined
          : ready
            ? inUse
              ? undefined
              : onUse
            : () => startModelDownload(row.id)
      }
    />
  );
}
