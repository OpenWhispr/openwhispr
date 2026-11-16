import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { SystemIcon } from '@/components/ui/SystemIcon';
import {
  ANDROID_MODELS,
  downloadAndroidModel,
  modelReady,
  useModelDownloads,
  type AndroidModelId,
} from '../models';
import { CLEANUP, SPEECH, applyPrivateConfig, privateSupported } from './setup';
import { AccentText, GlassButton, LinkButton, Screen, colors, s } from './kit';
import { appIcon } from './AppsScreen';
import type { OnboardingMode } from './flow';
import { useOnboardingT } from './strings';

const megabytes = (id: AndroidModelId) => `${Math.round(ANDROID_MODELS[id].bytes / 1e6)} MB`;

export function ModeScreen({
  mode,
  busy,
  onBack,
  onChoose,
}: {
  mode: OnboardingMode;
  busy?: boolean;
  onBack: () => void;
  onChoose: (mode: OnboardingMode) => void;
}) {
  const t = useOnboardingT();
  const [selected, setSelected] = useState<OnboardingMode>(mode);
  const canRunPrivate = privateSupported();
  const option = (value: OnboardingMode) => ({
    selected: selected === value,
    onPress: () => setSelected(value),
  });
  return (
    <Screen
      onBack={onBack}
      footer={<GlassButton label={t('continue')} busy={busy} onPress={() => onChoose(selected)} />}
    >
      <AccentText text={t('modeTitle')} />
      <Text style={s.body}>{t('modeBody')}</Text>
      <ModeCard
        {...option('cloud')}
        icon="AudioLines"
        title={t('cloudName')}
        lead={t('cloudWords')}
        points={[t('cloudPoint1'), t('cloudPoint2'), t('cloudPoint3')]}
      />
      <ModeCard
        {...option('private')}
        disabled={!canRunPrivate}
        icon="Lock"
        title={t('privateName')}
        lead={t('privateBody')}
        points={[t('privatePoint1')]}
        caution={t('privatePoint2')}
        footnote={canRunPrivate ? t('privateDownload') : t('privateUnsupported')}
      />
    </Screen>
  );
}

function ModeCard({
  selected,
  onPress,
  disabled,
  icon,
  title,
  lead,
  points,
  caution,
  footnote,
}: {
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  icon: 'AudioLines' | 'Lock';
  title: string;
  lead: string;
  points: string[];
  caution?: string;
  footnote?: string;
}) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled: Boolean(disabled) }}
      accessibilityLabel={`${title}. ${lead}`}
      disabled={disabled}
      onPress={onPress}
      style={[e.mode, selected && e.modeSelected, disabled && { opacity: 0.5 }]}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <SystemIcon name="circle" mdName={icon} size={20} color={colors.accent} />
        <Text style={{ flex: 1, fontSize: 19, fontFamily: AppFont.semibold, color: colors.ink }}>
          {title}
        </Text>
        <View style={[e.radio, selected && e.radioOn]}>
          {selected ? (
            <SystemIcon name="checkmark" mdName="Check" size={14} color="#FFFFFF" />
          ) : null}
        </View>
      </View>
      <View style={{ paddingLeft: 32, gap: 8 }}>
        <Text style={[s.body, { fontSize: 16 }]}>{lead}</Text>
        {points.map((point) => (
          <View key={point} style={e.point}>
            <SystemIcon name="checkmark" mdName="Check" size={15} color={colors.green} />
            <Text style={e.pointText}>{point}</Text>
          </View>
        ))}
        {caution ? (
          <View style={e.point}>
            <SystemIcon name="info.circle" mdName="Info" size={15} color={colors.tertiary} />
            <Text style={e.pointText}>{caution}</Text>
          </View>
        ) : null}
        {footnote ? <Text style={[s.caption, { fontSize: 13 }]}>{footnote}</Text> : null}
      </View>
    </Pressable>
  );
}

type DownloadState = 'waiting' | 'downloading' | 'ready' | 'failed';

function ModelRow({
  title,
  size,
  body,
  state,
  progress,
}: {
  title: string;
  size: string;
  body: string;
  state: DownloadState;
  progress: number;
}) {
  const t = useOnboardingT();
  const done = state === 'ready';
  return (
    <View style={e.model}>
      <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
        <View style={[e.modelIcon, done && { backgroundColor: '#E3F4E8' }]}>
          <SystemIcon
            name={done ? 'checkmark' : 'arrow.down'}
            mdName={done ? 'Check' : 'ArrowDown'}
            size={18}
            color={done ? colors.green : colors.accent}
          />
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
            <Text style={{ fontSize: 18, fontFamily: AppFont.medium, color: colors.ink }}>
              {title}
            </Text>
            <Text style={s.caption}>{size}</Text>
          </View>
          <Text style={s.caption}>{body}</Text>
        </View>
      </View>
      <View style={e.track}>
        <View
          style={[
            e.fill,
            { width: `${Math.round(progress * 100)}%` },
            done && { backgroundColor: colors.green },
          ]}
        />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={s.caption}>
          {done
            ? t('ready')
            : state === 'downloading'
              ? t('downloading')
              : state === 'failed'
                ? t('tryAgain')
                : t('waiting')}
        </Text>
        <Text style={s.caption}>{Math.round(progress * 100)}%</Text>
      </View>
    </View>
  );
}

export function PrivateSetupScreen({
  onBack,
  onReady,
  onUseCloud,
}: {
  onBack: () => void;
  onReady: () => void;
  onUseCloud: () => void;
}) {
  const t = useOnboardingT();
  const progress = useModelDownloads((state) => state.progress);
  const [states, setStates] = useState<Record<string, DownloadState>>({
    [SPEECH]: 'waiting',
    [CLEANUP]: 'waiting',
  });
  const [error, setError] = useState('');
  const running = useRef(false);
  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setError('');
    try {
      for (const id of [SPEECH, CLEANUP]) {
        if (await modelReady(id)) {
          setStates((current) => ({ ...current, [id]: 'ready' }));
          continue;
        }
        setStates((current) => ({ ...current, [id]: 'downloading' }));
        try {
          await downloadAndroidModel(id);
          setStates((current) => ({ ...current, [id]: 'ready' }));
        } catch (failure) {
          setStates((current) => ({ ...current, [id]: 'failed' }));
          throw failure;
        }
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      running.current = false;
    }
  }, []);
  useEffect(() => {
    void applyPrivateConfig();
    void run();
  }, [run]);
  const fraction = (id: AndroidModelId) =>
    states[id] === 'ready' ? 1 : Math.max(0, Math.min(1, progress[id] ?? 0));
  const total =
    (fraction(SPEECH) * ANDROID_MODELS[SPEECH].bytes +
      fraction(CLEANUP) * ANDROID_MODELS[CLEANUP].bytes) /
    (ANDROID_MODELS[SPEECH].bytes + ANDROID_MODELS[CLEANUP].bytes);
  const ready = states[SPEECH] === 'ready' && states[CLEANUP] === 'ready';
  return (
    <Screen
      onBack={onBack}
      footer={
        <>
          {error ? (
            <GlassButton label={t('tryAgain')} onPress={() => void run()} />
          ) : (
            <GlassButton
              label={ready ? t('continue') : t('settingUp', { percent: Math.round(total * 100) })}
              disabled={!ready}
              onPress={onReady}
            />
          )}
          <LinkButton label={t('useCloudInstead')} onPress={onUseCloud} />
        </>
      }
    >
      <AccentText text={t('privateSetupTitle')} />
      <Text style={s.body}>{t('privateSetupBody')}</Text>
      <ModelRow
        title={t('speechModel')}
        size={megabytes(SPEECH)}
        body={t('speechModelBody')}
        state={states[SPEECH]}
        progress={fraction(SPEECH)}
      />
      <ModelRow
        title={t('cleanupModel')}
        size={megabytes(CLEANUP)}
        body={t('cleanupModelBody')}
        state={states[CLEANUP]}
        progress={fraction(CLEANUP)}
      />
      {error ? (
        <Text accessibilityRole="alert" style={[s.body, { color: '#B42318' }]}>
          {error}
        </Text>
      ) : null}
    </Screen>
  );
}

export function PrivateReadyScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  return (
    <Screen onBack={onBack} footer={<GlassButton label={t('continue')} onPress={onNext} />}>
      <AccentText text={t('privateReadyTitle')} />
      <Text style={s.body}>{t('privateReadyBody')}</Text>
      <ModelRow
        title={t('speechModel')}
        size={megabytes(SPEECH)}
        body={t('speechModelBody')}
        state="ready"
        progress={1}
      />
      <ModelRow
        title={t('cleanupModel')}
        size={megabytes(CLEANUP)}
        body={t('cleanupModelBody')}
        state="ready"
        progress={1}
      />
    </Screen>
  );
}

const TOP_ROW = ['imessage', 'mail', 'notes', 'safari', 'chatgpt', 'docs', 'outlook'];
const BOTTOM_ROW = ['claude', 'x', 'gmail', 'whatsapp', 'slack', 'calendar', 'teams'];
const TILE = 72;
const GAP = 24;

function Marquee({ apps, reverse }: { apps: string[]; reverse?: boolean }) {
  const reduced = useReducedMotion();
  const offset = useSharedValue(0);
  const span = apps.length * (TILE + GAP);
  useEffect(() => {
    if (reduced) return;
    offset.value = withRepeat(
      withTiming(1, { duration: apps.length * 2600, easing: Easing.linear }),
      -1,
      false,
    );
  }, [apps.length, offset, reduced]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: (reverse ? offset.value - 1 : -offset.value) * span }],
  }));
  return (
    <View
      style={{ height: TILE + 56, overflow: 'hidden' }}
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View style={[{ flexDirection: 'row', gap: GAP, paddingVertical: 20 }, style]}>
        {[...apps, ...apps, ...apps].map((name, index) => (
          <View key={`${name}-${index}`} style={e.tile}>
            <Image source={appIcon(name)} style={e.tileImage} />
          </View>
        ))}
      </Animated.View>
    </View>
  );
}

export function ReadyScreen({ onDone }: { onDone: () => void }) {
  const t = useOnboardingT();
  return (
    <SafeAreaView style={s.page} edges={['top', 'bottom']}>
      <View style={{ flex: 1, justifyContent: 'center', gap: 28 }}>
        <Marquee apps={TOP_ROW} />
        <View style={{ paddingHorizontal: 24, gap: 12 }}>
          <AccentText center text={t('readyTitle')} />
          <Text style={[s.body, { textAlign: 'center' }]}>{t('readyBody')}</Text>
        </View>
        <Marquee apps={BOTTOM_ROW} reverse />
      </View>
      <View style={s.footer}>
        <GlassButton label={t('done')} onPress={onDone} />
      </View>
    </SafeAreaView>
  );
}

const e = StyleSheet.create({
  mode: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    padding: 16,
    gap: 10,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  modeSelected: { borderColor: colors.accent },
  radio: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: '#C9C6C0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  point: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pointText: { fontSize: 15, color: colors.secondary },
  model: { backgroundColor: colors.surface, borderRadius: 18, padding: 14, gap: 12 },
  modelIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.fill, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.brandMid },
  tile: {
    width: TILE,
    height: TILE,
    borderRadius: 17,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.10)',
    shadowColor: '#000000',
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 5,
  },
  tileImage: { width: TILE, height: TILE, borderRadius: 17 },
});
