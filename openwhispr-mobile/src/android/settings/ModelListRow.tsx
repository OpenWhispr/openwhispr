import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { ANDROID_MODELS, cancelAndroidDownload, modelReady } from '../models';
import { home } from '../home/kit';
import { Badge, settings } from './kit';
import { DownloadRing } from './DownloadRing';
import { useTimeLeft } from './ModelRow';
import { formatSize, modelName, type MODEL_ROWS } from './modelCatalog';
import { noOrphan, useSettingsT } from './strings';

type Row = (typeof MODEL_ROWS)[number];
/** absent: not on the phone · ready: on the phone, not in use · inUse: the one chosen. */
export type ModelState = 'absent' | 'downloading' | 'ready' | 'inUse';

const haptic = (type: Haptics.AndroidHaptics) =>
  Haptics.performAndroidHapticsAsync(type).catch(() => undefined);

/** Crossfades one slot's content when `slotKey` changes, so only that slot moves. */
function Swap({
  slotKey,
  duration,
  children,
  style,
}: {
  slotKey: string;
  duration: number;
  children: React.ReactNode;
  style?: object;
}) {
  const previous = useRef({ key: slotKey, node: children });
  const [leaving, setLeaving] = useState<React.ReactNode>(null);
  const enter = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (previous.current.key === slotKey || !duration) return;
    setLeaving(previous.current.node);
    enter.setValue(duration ? 0 : 1);
    Animated.timing(enter, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start(() => setLeaving(null));
  }, [slotKey, duration, enter]);
  // Runs after the effect above, so it still sees the content that is leaving.
  useEffect(() => {
    previous.current = { key: slotKey, node: children };
  });
  return (
    <View style={[{ alignItems: 'center', justifyContent: 'center' }, style]}>
      {leaving && (
        <Animated.View
          style={{
            position: 'absolute',
            opacity: enter.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
          }}
        >
          {leaving}
        </Animated.View>
      )}
      <Animated.View
        style={{
          opacity: enter,
          transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
        }}
      >
        {children}
      </Animated.View>
    </View>
  );
}

/** A Material radio. Choosing springs the dot in (0 → 1.15 → 1, 150 ms); un-choosing shrinks it. */
export function Radio({ on, reduceMotion }: { on: boolean; reduceMotion: boolean }) {
  const dot = useRef(new Animated.Value(on ? 1 : 0)).current;
  useEffect(() => {
    if (reduceMotion) {
      dot.setValue(on ? 1 : 0);
      return;
    }
    const step = (toValue: number, duration: number) =>
      Animated.timing(dot, {
        toValue,
        duration,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      });
    (on ? Animated.sequence([step(1.15, 100), step(1, 50)]) : step(0, 150)).start();
  }, [on, reduceMotion, dot]);
  return (
    <View
      style={{
        width: 22,
        height: 22,
        borderRadius: 11,
        borderWidth: 2,
        borderColor: on ? home.accent : home.tertiary,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Animated.View
        style={{
          width: 11,
          height: 11,
          borderRadius: 6,
          backgroundColor: home.accent,
          transform: [{ scale: dot }],
        }}
      />
    </View>
  );
}

/**
 * One model in the 8.3 v2 list. The leading slot says what kind of row it is: a download arrow
 * (not on the phone), the V1 ring (downloading), an empty radio (on the phone) or a filled one (in
 * use). Only that slot, the trailing slot and the tint ever change, so the list never jumps.
 */
export function ModelListRow({
  row,
  state,
  progress,
  dimmed,
  reduceMotion,
  onDownload,
  onUse,
  onRemove,
  onSettled,
}: {
  row: Row;
  state: ModelState;
  progress: number | undefined;
  dimmed: boolean;
  reduceMotion: boolean;
  onDownload: () => void;
  onUse?: () => void;
  onRemove: () => void;
  /** How a download ended: true once the model is on the phone. */
  onSettled: (ready: boolean) => void;
}) {
  const t = useSettingsT();
  const name = modelName(row.id);
  const total = ANDROID_MODELS[row.id].bytes;
  const timeLeft = useTimeLeft(progress);
  // Between the last byte and the readiness check the ring keeps spinning.
  const [checking, setChecking] = useState(false);
  const wasDownloading = useRef(state === 'downloading');
  useEffect(() => {
    const downloading = state === 'downloading';
    if (wasDownloading.current && !downloading) {
      setChecking(true);
      modelReady(row.id)
        .catch(() => false)
        .then((ok) => {
          // On success the ring keeps spinning until the list sees the model (below).
          if (ok) haptic(Haptics.AndroidHaptics.Confirm);
          else setChecking(false);
          onSettled(ok);
        });
    }
    wasDownloading.current = downloading;
  }, [state, row.id, onSettled]);
  useEffect(() => {
    if (checking && (state === 'ready' || state === 'inUse')) setChecking(false);
  }, [checking, state]);

  const shown: ModelState = checking ? 'downloading' : state;
  const settingUp = checking || (progress ?? 0) >= 0.98;
  const fast = reduceMotion ? 0 : 150;
  const morph = reduceMotion ? 0 : shown === 'absent' ? 200 : 240;

  const tint = useRef(new Animated.Value(shown === 'inUse' ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(tint, {
      toValue: shown === 'inUse' ? 1 : 0,
      duration: reduceMotion ? 0 : 200,
      useNativeDriver: false,
    }).start();
  }, [shown, reduceMotion, tint]);

  const leading =
    shown === 'absent' ? (
      <SystemIcon name="arrow.down.circle" mdName="CircleArrowDown" size={24} color={home.accent} />
    ) : shown === 'downloading' ? (
      <Pressable
        cssInterop={false}
        accessibilityRole="button"
        accessibilityLabel={t('cancelDownload', { model: name })}
        disabled={settingUp}
        hitSlop={10}
        onPress={() => {
          cancelAndroidDownload(row.id).catch(() => undefined);
        }}
      >
        <DownloadRing
          phase={settingUp ? 'setting-up' : 'downloading'}
          progress={progress ?? 1}
          reduceMotion={reduceMotion}
        />
      </Pressable>
    ) : (
      <Radio on={shown === 'inUse'} reduceMotion={reduceMotion} />
    );

  const line =
    shown === 'downloading'
      ? settingUp
        ? t('settingUp')
        : [
            t('sizeOf', {
              done: formatSize((progress ?? 0) * total).replace(/ (MB|GB)$/, ''),
              total: formatSize(total),
            }),
            timeLeft !== undefined &&
              (timeLeft < 90
                ? t('aboutSeconds', { count: Math.max(1, Math.round(timeLeft)) })
                : t('aboutMinutes', { count: Math.round(timeLeft / 60) })),
          ]
            .filter(Boolean)
            .join(' · ')
      : row.line
        ? `${t(row.line)} · ${formatSize(total)}`
        : formatSize(total);

  const trailing =
    shown === 'absent' ? (
      <Text style={[settings.rowValue, settings.tabular]}>{formatSize(total)}</Text>
    ) : shown === 'downloading' ? null : (
      <Pressable
        cssInterop={false}
        accessibilityRole="button"
        accessibilityLabel={t('removeModel', { model: name })}
        onPress={onRemove}
        style={({ pressed }) => ({
          width: 48,
          height: 48,
          marginRight: -12,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.5 : 1,
        })}
      >
        <SystemIcon
          name="trash"
          mdName="Trash2"
          size={20}
          color={shown === 'inUse' ? home.tertiary : home.secondary}
        />
      </Pressable>
    );

  const press =
    dimmed || shown === 'downloading' || shown === 'inUse'
      ? undefined
      : shown === 'absent'
        ? onDownload
        : () => {
            haptic(Haptics.AndroidHaptics.Clock_Tick);
            onUse?.();
          };

  return (
    <Pressable
      cssInterop={false}
      accessibilityRole={shown === 'ready' || shown === 'inUse' ? 'radio' : 'button'}
      accessibilityState={{ checked: shown === 'inUse', disabled: !press }}
      accessibilityLabel={
        shown === 'absent' ? t('downloadModel', { model: name }) : `${name}, ${line}`
      }
      disabled={!press}
      onPress={press}
    >
      {({ pressed }) => (
        <Animated.View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 16,
            minHeight: 64,
            paddingVertical: 8,
            opacity: dimmed ? 0.45 : pressed ? 0.7 : 1,
            backgroundColor: tint.interpolate({
              inputRange: [0, 1],
              outputRange: ['rgba(21,75,212,0)', home.tint],
            }),
          }}
        >
          <Swap
            slotKey={shown === 'inUse' ? 'ready' : shown}
            duration={shown === 'downloading' ? fast : morph}
            style={{ width: 28, height: 28 }}
          >
            {leading}
          </Swap>
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Text style={settings.title}>{name}</Text>
              {row.recommended && (shown === 'absent' || shown === 'downloading') && (
                <Badge label={t('recommended')} />
              )}
            </View>
            <Text
              numberOfLines={1}
              style={[settings.subtitle, settings.tabular]}
              accessibilityLiveRegion="polite"
            >
              {noOrphan(line)}
            </Text>
          </View>
          <Swap
            slotKey={shown === 'inUse' ? 'ready' : shown}
            duration={morph}
            style={{ minWidth: 36, alignItems: 'flex-end' }}
          >
            {trailing}
          </Swap>
        </Animated.View>
      )}
    </Pressable>
  );
}
