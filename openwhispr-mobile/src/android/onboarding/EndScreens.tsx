import { useEffect, useState } from 'react';
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
import { privateSupported } from './setup';
import { AccentText, GlassButton, Screen, colors, s } from './kit';
import { appIcon } from './AppsScreen';
import type { OnboardingMode } from './flow';
import { useOnboardingT } from './strings';

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
      <Text textBreakStrategy="balanced" style={s.body}>
        {t('modeBody')}
      </Text>
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
        <Text textBreakStrategy="balanced" style={[s.body, { fontSize: 16 }]}>
          {lead}
        </Text>
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
        {footnote ? (
          <Text textBreakStrategy="balanced" style={[s.caption, { fontSize: 13 }]}>
            {footnote}
          </Text>
        ) : null}
      </View>
    </Pressable>
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

export function ReadyScreen({ onDone, onDevice }: { onDone: () => void; onDevice?: boolean }) {
  const t = useOnboardingT();
  return (
    <SafeAreaView style={s.page} edges={['top', 'bottom']}>
      <View style={{ flex: 1, justifyContent: 'center', gap: 28 }}>
        <Marquee apps={TOP_ROW} />
        <View style={{ paddingHorizontal: 24, gap: 12 }}>
          <AccentText center text={t('readyTitle')} />
          <Text textBreakStrategy="balanced" style={[s.body, { textAlign: 'center' }]}>
            {t(onDevice ? 'readyBodyDevice' : 'readyBody')}
          </Text>
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
