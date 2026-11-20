import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { ANDROID_MODELS, useModelDownloads, type AndroidModelId } from '../models';
import { DownloadRing } from '../settings/DownloadRing';
import { edgeCard, sectionLabel } from '../settings/look';
import { useReduceMotion } from '../settings/kit';
import { TILE_FILL } from '../home/kit';
import {
  modelFor,
  retryDeviceDownloads,
  runDeviceDownloads,
  setDeviceExtra,
  useDeviceSetup,
  type DeviceExtra,
} from './deviceSetup';
import { applyPrivateConfig } from './setup';
import { AccentText, GLASS_GRADIENT, GlassButton, LinkButton, Screen, colors, s } from './kit';
import { Glyph } from './PracticeBubble';
import { useOnboardingT, type OnboardingKey } from './strings';

type Item = 'speech' | DeviceExtra;

const ROWS: Record<
  Item,
  { name: OnboardingKey; body: OnboardingKey; icon: LucideIconName | 'sparkle' }
> = {
  speech: { name: 'speechName', body: 'speechBody', icon: 'AudioLines' },
  cleanup: { name: 'cleanupName', body: 'cleanupBody', icon: 'PencilLine' },
  assistant: { name: 'assistantName', body: 'assistantBody', icon: 'sparkle' },
  speakers: { name: 'speakersName', body: 'speakersBody', icon: 'Users' },
};
const EXTRAS: DeviceExtra[] = ['cleanup', 'assistant', 'speakers'];

// Big models read in tens of megabytes, as the board does (490 MB, 670 MB); small ones exactly (42 MB).
const megabytes = (bytes: number) =>
  bytes >= 1e8 ? Math.round(bytes / 1e7) * 10 : Math.round(bytes / 1e6);
const size = (id: AndroidModelId) => `${megabytes(ANDROID_MODELS[id].bytes)} MB`;

function useModelState(id: AndroidModelId) {
  const state = useDeviceSetup((current) => current.states[id]);
  const progress = useModelDownloads((current) => current.progress[id] ?? 0);
  return { state, progress };
}

/**
 * 14p "Set up your device" (onboarding v4, Settings language with the V1 ring). Speech is required
 * and starts at once; Cleanup, the Assistant (the same 490 MB model as Cleanup) and Meeting
 * speakers are optional "Add" rows that queue behind it. Continue waits only for Speech.
 */
export function DeviceSetupScreen({
  onBack,
  onReady,
  onUseCloud,
}: {
  onBack: () => void;
  onReady: () => void;
  onUseCloud: () => void;
}) {
  const t = useOnboardingT();
  const choices = useDeviceSetup((current) => current.choices);
  const error = useDeviceSetup((current) => current.error);
  const speech = useModelState(modelFor('speech'));
  useEffect(() => {
    void applyPrivateConfig(choices);
    void runDeviceDownloads();
    // Applied once on arrival; Continue applies the final choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const ready = speech.state === 'ready';
  return (
    <Screen
      onBack={onBack}
      footer={
        <>
          {error ? (
            <GlassButton label={t('tryAgain')} onPress={retryDeviceDownloads} />
          ) : (
            <GlassButton
              label={t('continue')}
              disabled={!ready}
              onPress={() => {
                void applyPrivateConfig(useDeviceSetup.getState().choices);
                onReady();
              }}
            />
          )}
          <LinkButton label={t('useCloudInstead')} onPress={onUseCloud} />
        </>
      }
    >
      <View style={{ gap: 10, marginBottom: 4 }}>
        <AccentText center text={t('deviceSetupTitle')} />
        <Text textBreakStrategy="balanced" style={[s.body, { textAlign: 'center' }]}>
          {t('deviceSetupBody')}
        </Text>
      </View>
      <Section label={t('required')}>
        <SetupRow item="speech" />
      </Section>
      <Section label={t('optional')}>
        {EXTRAS.map((item, index) => (
          <SetupRow key={item} item={item} divider={index > 0} added={choices[item]} />
        ))}
      </Section>
      {error ? (
        <Text accessibilityRole="alert" style={[s.body, { color: '#B42318' }]}>
          {error}
        </Text>
      ) : null}
    </Screen>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={[sectionLabel, d.section]}>{label.toUpperCase()}</Text>
      <View style={edgeCard}>{children}</View>
    </View>
  );
}

function Tile({ item, glass, muted }: { item: Item; glass?: boolean; muted?: boolean }) {
  const icon = ROWS[item].icon;
  const color = glass ? '#FFFFFF' : muted ? colors.tertiary : colors.ink;
  const glyph =
    icon === 'sparkle' ? (
      <Glyph name="sparkle" size={14} color={color} />
    ) : (
      <SystemIcon name="circle" mdName={icon} size={18} color={color} />
    );
  return glass ? (
    <LinearGradient colors={GLASS_GRADIENT} style={d.tile}>
      {glyph}
    </LinearGradient>
  ) : (
    <View style={[d.tile, { backgroundColor: TILE_FILL }]}>{glyph}</View>
  );
}

function SetupRow({ item, divider, added }: { item: Item; divider?: boolean; added?: boolean }) {
  const t = useOnboardingT();
  const reduceMotion = useReduceMotion();
  const choices = useDeviceSetup((current) => current.choices);
  const id = modelFor(item);
  const { state, progress } = useModelState(id);
  const row = ROWS[item];
  const on = item === 'speech' || added;
  // The shared text model: the row that didn't add it says it costs nothing more.
  const shares =
    (item === 'assistant' && choices.cleanup && !choices.assistant) ||
    (item === 'cleanup' && choices.assistant && !choices.cleanup);
  const downloading = state === 'downloading';
  const megabytesLine =
    on && downloading && progress < 0.98
      ? t('progressOf', {
          done: Math.round((progress * ANDROID_MODELS[id].bytes) / 1e6),
          total: size(id),
        })
      : size(id);
  const sizeLine = [
    megabytesLine,
    on && state === 'queued' && item !== 'speech' ? t('queued') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const name = t(row.name);
  return (
    <View style={[d.row, divider && d.divider, item === 'assistant' && { minHeight: 90 }]}>
      <Tile item={item} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={d.name}>{name}</Text>
          {item === 'speech' ? (
            <View style={d.pill}>
              <Text style={d.pillLabel}>{t('required')}</Text>
            </View>
          ) : null}
        </View>
        {item === 'assistant' ? (
          <>
            <Text style={d.body}>{t(row.body)}</Text>
            {shares ? (
              <Text style={[d.body, { color: colors.accent }]}>{t('noExtraDownload')}</Text>
            ) : on && !choices.cleanup ? (
              <Text style={d.body}>{sizeLine}</Text>
            ) : (
              <Text style={d.body}>{t('sameModel')}</Text>
            )}
          </>
        ) : (
          <>
            <Text style={d.body}>{shares ? t(row.body) : `${t(row.body)} · ${sizeLine}`}</Text>
            {shares ? (
              <Text style={[d.body, { color: colors.accent }]}>{t('noExtraDownload')}</Text>
            ) : null}
          </>
        )}
      </View>
      {on ? (
        <Pressable
          cssInterop={false}
          disabled={item === 'speech' || state === 'ready'}
          accessibilityRole="button"
          accessibilityLabel={
            state === 'ready' ? `${name}, ${t('onThisPhone')}` : t('stopDownload', { name })
          }
          accessibilityState={{ disabled: item === 'speech' || state === 'ready' }}
          // Stopping an optional download takes it off the list again.
          onPress={() => item !== 'speech' && setDeviceExtra(item, false)}
          hitSlop={10}
        >
          {state === 'queued' || !state ? (
            <QueuedRing />
          ) : state === 'failed' ? (
            <SystemIcon
              name="exclamationmark.circle"
              mdName="CircleAlert"
              size={24}
              color="#B42318"
            />
          ) : (
            <DownloadRing
              phase={state === 'ready' ? 'done' : progress >= 0.98 ? 'setting-up' : 'downloading'}
              progress={progress}
              reduceMotion={reduceMotion}
            />
          )}
        </Pressable>
      ) : (
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={t('addItem', { name })}
          onPress={() => setDeviceExtra(item as DeviceExtra, true)}
          hitSlop={12}
          style={({ pressed }) => [{ paddingVertical: 6 }, pressed && { opacity: 0.6 }]}
        >
          <Text style={d.add}>{t('add')}</Text>
        </Pressable>
      )}
    </View>
  );
}

// Waiting its turn: a dashed ring the size of the V1 download ring.
function QueuedRing() {
  return (
    <Svg width={28} height={28}>
      <Circle
        cx={14}
        cy={14}
        r={11}
        stroke="#C9C8C4"
        strokeWidth={2}
        strokeDasharray="3 3"
        fill="none"
      />
    </Svg>
  );
}

/** "Speech and Cleanup", "Speech, Cleanup and Assistant". */
function joinNames(names: string[], t: ReturnType<typeof useOnboardingT>): string {
  if (names.length < 2) return names[0] ?? '';
  return t('and', { first: names.slice(0, -1).join(', '), last: names[names.length - 1] });
}

/**
 * 15p "Your device is ready": what is on the phone (an optional model still arriving keeps its
 * ring) and what was skipped, which stays off until Settings turns it on.
 */
export function DeviceReadyScreen({ onNext }: { onNext: () => void }) {
  const t = useOnboardingT();
  const choices = useDeviceSetup((current) => current.choices);
  const onPhone: Item[] = ['speech', ...EXTRAS.filter((item) => choices[item])];
  const skipped = EXTRAS.filter((item) => !choices[item]);
  const names = onPhone.map((item) => t(ROWS[item].name));
  const body = !skipped.length
    ? t('deviceReadyAll')
    : t(names.length > 1 ? 'deviceReadyMany' : 'deviceReadyOne', {
        names: joinNames(names, t),
      });
  const [toast, setToast] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setToast(false), 4000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <Screen
      footer={
        <>
          <View style={d.toastSlot} pointerEvents="none">
            {toast ? (
              <Animated.View
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(200)}
                style={d.toast}
                accessibilityLiveRegion="polite"
              >
                <Text style={d.toastLabel}>{t('deviceToast')}</Text>
              </Animated.View>
            ) : null}
          </View>
          <GlassButton label={t('continue')} onPress={onNext} />
        </>
      }
    >
      <View style={{ gap: 10, marginBottom: 4 }}>
        <AccentText center text={t('deviceReadyTitle')} />
        <Text textBreakStrategy="balanced" style={[s.body, { textAlign: 'center' }]}>
          {body}
        </Text>
      </View>
      <Section label={t('onThisPhone')}>
        {onPhone.map((item, index) => (
          <ReadyRow key={item} item={item} divider={index > 0} />
        ))}
      </Section>
      {skipped.length ? (
        <Section label={t('skippedOff')}>
          {skipped.map((item, index) => (
            <View key={item} style={[d.row, index > 0 && d.divider]}>
              <View style={{ opacity: 0.55 }}>
                <Tile item={item} muted />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[d.name, { color: colors.tertiary }]}>{t(ROWS[item].name)}</Text>
                <Text style={[d.body, { color: colors.tertiary }]}>{t('turnOnInSettings')}</Text>
              </View>
              <Text style={[d.body, { color: colors.tertiary }]}>{t('off')}</Text>
            </View>
          ))}
        </Section>
      ) : null}
    </Screen>
  );
}

function ReadyRow({ item, divider }: { item: Item; divider: boolean }) {
  const t = useOnboardingT();
  const reduceMotion = useReduceMotion();
  const id = modelFor(item);
  const { state, progress } = useModelState(id);
  const row = ROWS[item];
  return (
    <View style={[d.row, divider && d.divider]}>
      <Tile item={item} glass />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={d.name}>{t(row.name)}</Text>
        <Text style={d.body}>{`${t(row.body)} · ${size(id)}`}</Text>
      </View>
      {state === 'ready' ? (
        <SystemIcon name="checkmark" mdName="Check" size={20} color={colors.accent} />
      ) : state === 'downloading' ? (
        <DownloadRing
          phase={progress >= 0.98 ? 'setting-up' : 'downloading'}
          progress={progress}
          reduceMotion={reduceMotion}
        />
      ) : (
        <QueuedRing />
      )}
    </View>
  );
}

const d = StyleSheet.create({
  section: { paddingHorizontal: 4, color: colors.tertiary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    minHeight: 72,
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
  tile: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  name: { fontSize: 17, fontFamily: AppFont.medium, color: colors.ink },
  body: { fontSize: 14, lineHeight: 19, color: colors.secondary },
  pill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: colors.accentSoft,
  },
  pillLabel: { fontSize: 12, fontFamily: AppFont.medium, color: colors.accent },
  add: { fontSize: 16, fontFamily: AppFont.semibold, color: colors.accent },
  toastSlot: { minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  toast: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 22,
    backgroundColor: '#22211F',
  },
  toastLabel: { fontSize: 14, fontFamily: AppFont.medium, color: '#FFFFFF' },
});
