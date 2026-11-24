import { useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SvgXml } from 'react-native-svg';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { ProgressBar } from '../controls';
import { useTheme } from '../ThemeProvider';
import { useNavigationBarCanvas } from '../navigationBar';
import { showToast } from '../settings/kit';
import { APP_LOGOS, type AppLogo } from './appLogos';
import { useTranslation } from 'react-i18next';
import { KIND_APPS } from './examples';
import {
  AppMarks,
  CloseButton,
  DiffText,
  GlassCta,
  InAppPreview,
  KIND_ROW,
  PickedCheck,
  useToneText,
  useExamples,
} from './kit';
import { useStyleT, type StyleKey } from './strings';
import {
  TONE_KINDS,
  TONE_OPTIONS,
  saveToneStyle,
  useToneStyle,
  type DictationTone,
  type ToneKind,
  type ToneStyles,
} from './toneStyle';

const QUESTION: Record<ToneKind, StyleKey> = {
  personal: 'askPersonal',
  work: 'askWork',
  email: 'askEmail',
  other: 'askOther',
};
const APPS: Record<ToneKind, StyleKey> = {
  personal: 'appsPersonal',
  work: 'appsWork',
  email: 'appsEmail',
  other: 'appsOther',
};
const SUMMARY_LOGO: Record<ToneKind, AppLogo> = {
  personal: 'whatsapp',
  work: 'slack',
  email: 'gmail',
  other: 'notion',
};

type Step = 'intro' | ToneKind | 'done';

/**
 * Tone & Style's setup (Figma "Styles · Variant B", section 2): an intro, one swipe deck of tones
 * per kind of app, then a summary. Opened only from Home's card and the Style tab. Nothing is
 * saved until Done, which turns Tone & Style on; the X leaves without saving.
 */
export default function ToneSetupScreen() {
  const k = useTheme().tokens;
  const t = useStyleT();
  const saved = useToneStyle();
  const [step, setStep] = useState<Step>('intro');
  const [tones, setTones] = useState<ToneStyles>(saved.tones);
  // A row tapped on the summary opens its step, and "Sounds like me" goes back to the summary.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  useNavigationBarCanvas(k.canvas);

  const close = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)/(style)'));
  const back = () => {
    if (step === 'intro') return close();
    if (editing) {
      setEditing(false);
      return setStep('done');
    }
    if (step === 'done') return setStep('other');
    const index = TONE_KINDS.indexOf(step);
    setStep(index === 0 ? 'intro' : TONE_KINDS[index - 1]);
  };
  const live = useRef(back);
  live.current = back;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      live.current();
      return true;
    });
    return () => sub.remove();
  }, []);

  const finish = async () => {
    setSaving(true);
    try {
      await saveToneStyle({ enabled: true, setUp: true, tones });
      // Setup closes back onto a tab, so the toast sits above the tab bar.
      showToast(t('saved'), 'success', undefined, { aboveTabBar: true });
      close();
    } catch {
      showToast(t('saveFailed'), 'error');
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: k.canvas }}>
      {step === 'intro' ? (
        <Intro onStart={() => setStep('personal')} onClose={close} />
      ) : step === 'done' ? (
        <Summary
          tones={tones}
          saving={saving}
          onClose={close}
          onEdit={(kind) => {
            setEditing(true);
            setStep(kind);
          }}
          onDone={() => void finish()}
        />
      ) : (
        <KindStep
          key={step}
          kind={step}
          initial={tones[step]}
          onClose={close}
          onPick={(tone) => {
            setTones((current) => ({ ...current, [step]: tone }));
            const index = TONE_KINDS.indexOf(step);
            if (editing || index === TONE_KINDS.length - 1) {
              setEditing(false);
              setStep('done');
            } else setStep(TONE_KINDS[index + 1]);
          }}
        />
      )}
    </SafeAreaView>
  );
}

/** 2a: three tone cards fanned like the deck that follows, the pitch and the first step. */
function Intro({ onStart, onClose }: { onStart: () => void; onClose: () => void }) {
  const th = useTheme();
  const k = th.tokens;
  const t = useStyleT();
  const tone = useToneText();
  const { intro } = useExamples();
  const fan: { tone: 'formal' | 'casual' | 'very_casual'; x: number; y: number; rotate: string }[] =
    [
      { tone: 'formal', x: -78, y: 14, rotate: '-6deg' },
      { tone: 'very_casual', x: 78, y: 14, rotate: '6deg' },
      { tone: 'casual', x: 0, y: 0, rotate: '0deg' },
    ];
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingTop: 16, paddingHorizontal: 20 }}>
        <CloseButton onPress={onClose} />
      </View>
      <View
        importantForAccessibility="no-hide-descendants"
        style={{ height: 204, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}
      >
        {fan.map((card) => {
          const front = card.tone === 'casual';
          return (
            <View
              key={card.tone}
              style={[
                th.flat,
                {
                  position: 'absolute',
                  width: 200,
                  borderRadius: 18,
                  padding: 12,
                  gap: 8,
                  transform: [
                    { translateX: card.x },
                    { translateY: card.y },
                    { rotate: card.rotate },
                  ],
                },
                front && { borderWidth: 1.5, borderColor: k.pickedRing },
              ]}
            >
              <View style={{ gap: 2 }}>
                <Text style={{ fontSize: 17, lineHeight: 22, fontWeight: '700', color: k.ink }}>
                  {tone.name(card.tone)}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{ fontSize: 12, lineHeight: 16, color: k.secondary }}
                >
                  {tone.description(card.tone)}
                </Text>
              </View>
              <View style={{ backgroundColor: k.surface2, borderRadius: 10, padding: 10 }}>
                <DiffText example={intro[card.tone]} />
              </View>
            </View>
          );
        })}
      </View>
      <View style={{ paddingHorizontal: 24, paddingTop: 28, gap: 12 }}>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 32, lineHeight: 38, fontWeight: '700', color: k.ink }}
        >
          {t('introTitle')}
        </Text>
        <Text style={{ fontSize: 16, lineHeight: 22, color: k.secondary }}>{t('introBody')}</Text>
        <AppMarks
          logos={['whatsapp', 'messages', 'slack', 'gmail', 'outlook', 'notion']}
          size={22}
          behind={k.canvas}
          overlap={4}
        />
      </View>
      <View style={{ flex: 1 }} />
      <View style={{ paddingHorizontal: 20, paddingBottom: 20, gap: 4, alignItems: 'center' }}>
        <GlassCta label={t('letsPersonalize')} onPress={onStart} />
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => ({
            minHeight: 48,
            paddingHorizontal: 24,
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ fontSize: 15, lineHeight: 20, fontWeight: '500', color: k.secondary }}>
            {t('notNow')}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** The step counter and the shared progress bar, top right. */
function Progress({ index }: { index: number }) {
  const k = useTheme().tokens;
  const t = useStyleT();
  return (
    <View
      accessible
      accessibilityLabel={t('stepOf', { index: index + 1, count: TONE_KINDS.length })}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      <Text style={{ fontSize: 13, lineHeight: 17, fontWeight: '500', color: k.secondary }}>
        {t('stepOf', { index: index + 1, count: TONE_KINDS.length })}
      </Text>
      <ProgressBar value={(index + 1) / TONE_KINDS.length} style={{ width: 120 }} />
    </View>
  );
}

const CARD_GAP = 12;
const SIDE = 40;

/** 2b–2e: a swipe deck of this kind's tones; the centred card is the pick. */
function KindStep({
  kind,
  initial,
  onClose,
  onPick,
}: {
  kind: ToneKind;
  initial: DictationTone;
  onClose: () => void;
  onPick: (tone: DictationTone) => void;
}) {
  const th = useTheme();
  const k = th.tokens;
  const t = useStyleT();
  const tone = useToneText();
  // The cards keep the app's direction inside a deck that always runs left to right.
  const cardDirection = useTranslation().i18n.dir() === 'rtl' ? 'rtl' : 'ltr';
  const { width } = useWindowDimensions();
  const options = TONE_OPTIONS[kind];
  const [index, setIndex] = useState(Math.max(0, options.indexOf(initial)));
  const cardWidth = Math.min(width - SIDE * 2, 420);
  const side = (width - cardWidth) / 2;
  const interval = cardWidth + CARD_GAP;
  const deck = useRef<ScrollView>(null);
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(event.nativeEvent.contentOffset.x / interval);
    setIndex(Math.min(options.length - 1, Math.max(0, next)));
  };
  const show = (next: number) => {
    setIndex(next);
    deck.current?.scrollTo({ x: next * interval, animated: true });
  };
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          paddingTop: 16,
          paddingHorizontal: 20,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <CloseButton onPress={onClose} />
        <Progress index={TONE_KINDS.indexOf(kind)} />
      </View>
      <View style={{ paddingTop: 28, paddingHorizontal: 24, gap: 12 }}>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 32, lineHeight: 38, fontWeight: '700', color: k.ink }}
        >
          {t(QUESTION[kind])}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <AppMarks logos={KIND_APPS[kind]} size={22} behind={k.canvas} overlap={7} />
          <Text style={{ flexShrink: 1, fontSize: 14, lineHeight: 18, color: k.secondary }}>
            {t(APPS[kind])}
          </Text>
        </View>
      </View>
      <ScrollView
        ref={deck}
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={interval}
        decelerationRate="fast"
        disableIntervalMomentum
        contentOffset={{ x: index * interval, y: 0 }}
        onMomentumScrollEnd={settle}
        onScrollEndDrag={settle}
        // The deck runs left to right in every language: Android measures a right-to-left
        // horizontal scroll from the other end, which landed Arabic on the wrong card.
        style={{ flexGrow: 0, direction: 'ltr' }}
        contentContainerStyle={{
          paddingHorizontal: side,
          paddingTop: 28,
          paddingBottom: 8,
          gap: CARD_GAP,
        }}
      >
        {options.map((option, i) => {
          const picked = i === index;
          return (
            <Pressable
              key={option}
              cssInterop={false}
              accessibilityRole="radio"
              accessibilityState={{ checked: picked }}
              accessibilityLabel={`${tone.name(option)}. ${tone.description(option)}`}
              onPress={() => show(i)}
              style={[
                th.flat,
                {
                  width: cardWidth,
                  alignSelf: 'flex-start',
                  borderRadius: 24,
                  paddingTop: 18,
                  paddingBottom: 16,
                  paddingHorizontal: 16,
                  gap: 12,
                  opacity: picked ? 1 : 0.55,
                  direction: cardDirection,
                },
                picked && { borderWidth: 2, borderColor: k.pickedRing },
              ]}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ fontSize: 22, lineHeight: 28, fontWeight: '700', color: k.ink }}>
                    {tone.name(option)}
                  </Text>
                  <Text style={{ fontSize: 13, lineHeight: 17, color: k.secondary }}>
                    {tone.description(option)}
                  </Text>
                </View>
                {picked ? <PickedCheck /> : null}
              </View>
              <InAppPreview kind={kind} tone={option} />
            </Pressable>
          );
        })}
      </ScrollView>
      <View
        importantForAccessibility="no-hide-descendants"
        style={{
          flexDirection: 'row',
          justifyContent: 'center',
          gap: 6,
          paddingTop: 4,
          direction: 'ltr',
        }}
      >
        {options.map((option, i) => (
          <View
            key={option}
            style={[
              { height: 6, borderRadius: 3, width: i === index ? 20 : 6 },
              i === index ? th.glass : { backgroundColor: k.dotIdle },
            ]}
          />
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <View style={{ paddingHorizontal: 20, paddingBottom: 20, gap: 12, alignItems: 'center' }}>
        <GlassCta label={t('soundsLikeMe')} onPress={() => onPick(options[index])} />
        <Text style={{ fontSize: 14, lineHeight: 18, fontWeight: '500', color: k.secondary }}>
          {t('swipeToCompare')}
        </Text>
      </View>
    </View>
  );
}

/** 2f: the four picks; a row opens its step again. Done saves and turns Tone & Style on. */
function Summary({
  tones,
  saving,
  onClose,
  onEdit,
  onDone,
}: {
  tones: ToneStyles;
  saving: boolean;
  onClose: () => void;
  onEdit: (kind: ToneKind) => void;
  onDone: () => void;
}) {
  const th = useTheme();
  const k = th.tokens;
  const t = useStyleT();
  const tone = useToneText();
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingTop: 16, paddingHorizontal: 20 }}>
        <CloseButton onPress={onClose} />
      </View>
      <View style={{ paddingTop: 28, paddingHorizontal: 24, gap: 12 }}>
        <Text
          accessibilityRole="header"
          style={{ fontSize: 32, lineHeight: 38, fontWeight: '700', color: k.ink }}
        >
          {t('doneTitle')}
        </Text>
        <Text style={{ fontSize: 16, lineHeight: 22, color: k.secondary }}>{t('doneBody')}</Text>
      </View>
      <View
        style={[
          th.flat,
          { marginTop: 20, marginHorizontal: 20, borderRadius: 16, overflow: 'hidden' },
        ]}
      >
        {TONE_KINDS.map((kind, i) => (
          <View key={kind}>
            {i > 0 ? (
              <View style={{ height: 1, marginLeft: 62, backgroundColor: k.hairline }} />
            ) : null}
            <Pressable
              cssInterop={false}
              accessibilityRole="button"
              accessibilityLabel={`${t(KIND_ROW[kind])}, ${tone.name(tones[kind])}`}
              onPress={() => onEdit(kind)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 60,
                paddingLeft: 14,
                paddingRight: 12,
                backgroundColor: pressed ? k.tile : undefined,
              })}
            >
              <View
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  backgroundColor: k.tile,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <SvgXml xml={APP_LOGOS[SUMMARY_LOGO[kind]]} width={22} height={22} />
              </View>
              <Text
                style={{
                  flex: 1,
                  fontSize: 16,
                  lineHeight: 22,
                  fontWeight: '500',
                  color: k.ink,
                }}
              >
                {t(KIND_ROW[kind])}
              </Text>
              {/* Capped and wrapping, so a long tone name (Russian, Japanese) never breaks the
                  row's label mid-word. */}
              <Text
                style={{
                  flexShrink: 1,
                  maxWidth: '40%',
                  fontSize: 15,
                  lineHeight: 20,
                  color: k.secondary,
                  textAlign: 'right',
                }}
              >
                {tone.name(tones[kind])}
              </Text>
              <SystemIcon name="chevron.right" mdName="ChevronRight" size={20} color={k.tertiary} />
            </Pressable>
          </View>
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <View style={{ paddingHorizontal: 20, paddingBottom: 20 }}>
        <GlassCta label={t('done')} onPress={onDone} disabled={saving} />
      </View>
    </View>
  );
}
