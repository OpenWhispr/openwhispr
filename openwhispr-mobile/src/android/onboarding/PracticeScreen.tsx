import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Dimensions,
  Image,
  Keyboard,
  Pressable,
  StatusBar,
  StyleSheet,
  TextInput,
  View,
  type KeyboardEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { AccentText, CircleButton, GlassButton, PillButton, colors, s } from './kit';
import { PracticeBubble, type BubbleState } from './PracticeBubble';
import { PracticeRecorder, requestMicrophone } from './practiceRecorder';
import { useOnboardingT, type OnboardingKey } from './strings';

export type PracticeKind = 'message' | 'email' | 'list';

// The email written in Practice 2; Practice 4 edits it.
let practiceEmail = '';
export function rememberedPracticeEmail(): string {
  return practiceEmail;
}

// Where the keyboard's top edge was last seen, in screen coordinates. The guidance and the
// bubble (or the button) stay pinned there even while the keyboard is closed, as in Wispr Flow.
let rememberedKeyboardTop: number | null = null;
export function anchorTop(current: number | null): number {
  if (current !== null) return current;
  if (rememberedKeyboardTop !== null) return rememberedKeyboardTop;
  return Dimensions.get('screen').height * 0.58;
}

type Phase = 'blank' | 'focused' | 'listening' | 'processing' | 'inserted' | 'done';

const ICONS = {
  message: require('./assets/apps/whatsapp.png'),
  email: require('./assets/apps/gmail.png'),
  list: require('./assets/app-icon.png'),
};

const COPY: Record<
  PracticeKind,
  { app: OnboardingKey; placeholder: OnboardingKey; start: OnboardingKey; success: OnboardingKey }
> = {
  message: {
    app: 'appWhatsApp',
    placeholder: 'messagePlaceholder',
    start: 'hintTapBubble',
    success: 'hintBubbleHides',
  },
  email: {
    app: 'appGmail',
    placeholder: 'emailScript',
    start: 'hintEmail',
    success: 'hintEmailDone',
  },
  list: { app: 'appNotes', placeholder: 'listScript', start: 'hintList', success: 'hintListDone' },
};

export function PracticeScreen({
  kind,
  onBack,
  onNext,
}: {
  kind: PracticeKind;
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useOnboardingT();
  const copy = COPY[kind];
  const input = useRef<TextInput>(null);
  const root = useRef<View>(null);
  const recorder = useRef(new PracticeRecorder());
  const mounted = useRef(true);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('blank');
  const [focused, setFocused] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [error, setError] = useState('');
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [overlayBottom, setOverlayBottom] = useState(16);

  const place = useCallback((top: number | null) => {
    if (top === null) return;
    root.current?.measureInWindow((_x, y, _w, height) => {
      // The keyboard reports screen coordinates; window coordinates start below the status bar.
      const bottom = y + height + (StatusBar.currentHeight ?? 0);
      if (mounted.current) setOverlayBottom(Math.max(12, bottom - top + 12));
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const show = Keyboard.addListener('keyboardDidShow', (event: KeyboardEvent) => {
      rememberedKeyboardTop = event.endCoordinates.screenY;
      setKeyboardTop(event.endCoordinates.screenY);
      place(event.endCoordinates.screenY);
    });
    // Closing the keyboard (back gesture) leaves the box focused; treat it as leaving the box.
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardTop(null);
      input.current?.blur();
    });
    // The keyboard can stay open from the previous practice, so no show event arrives.
    const open = Keyboard.isVisible() ? Keyboard.metrics() : undefined;
    if (open) {
      rememberedKeyboardTop = open.screenY;
      setKeyboardTop(open.screenY);
      place(open.screenY);
    }
    const app = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && recorder.current.active) {
        void recorder.current.cancel();
        setPhase(text ? 'inserted' : 'focused');
      }
    });
    const current = recorder.current;
    return () => {
      mounted.current = false;
      show.remove();
      hide.remove();
      app.remove();
      void current.cancel();
    };
    // Recording stops on leaving the app regardless of what was typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);

  // Measure again once the screen has laid out: the first measurement can run before layout.
  useEffect(() => {
    const frame = requestAnimationFrame(() => place(anchorTop(keyboardTop)));
    return () => cancelAnimationFrame(frame);
  }, [keyboardTop, place]);

  const success = phase === 'done';
  const start = async () => {
    setError('');
    const access = await requestMicrophone();
    if (access !== 'granted') {
      Alert.alert(t('micNeededTitle'), t('micNeededBody'), [
        { text: t('cancel'), style: 'cancel' },
        ...(access === 'blocked'
          ? [{ text: t('openSettings'), onPress: () => AndroidDictation?.openSettings('app') }]
          : []),
      ]);
      return;
    }
    try {
      await recorder.current.start();
      setPhase('listening');
    } catch (failure) {
      setError(t('practiceFailed', { message: (failure as Error).message }));
    }
  };

  const stop = async () => {
    setPhase('processing');
    try {
      const result = await recorder.current.finish(kind === 'message' ? undefined : kind);
      if (!mounted.current) return;
      setText(result.trim());
      if (kind === 'email') practiceEmail = result.trim();
      if (kind === 'message') setPhase('inserted');
      else setPhase('done');
    } catch (failure) {
      if (!mounted.current) return;
      const message = (failure as Error).message;
      setError(/hear|speech/i.test(message) ? t('noSpeech') : t('practiceFailed', { message }));
      setPhase(text ? 'inserted' : 'focused');
    }
  };

  const cancel = () => {
    void recorder.current.cancel();
    setPhase(text ? 'inserted' : 'focused');
  };

  const onBlur = () => {
    setFocused(false);
    if (recorder.current.active) cancel();
    if (kind === 'message' && text && phase === 'inserted') setPhase('done');
  };

  const bubbleState: BubbleState =
    phase === 'listening'
      ? 'listening'
      : phase === 'processing'
        ? 'processing'
        : nudge
          ? 'pulsing'
          : 'idle';
  const keyboardUp = focused && keyboardTop !== null;
  // The bubble keeps its place above the keyboard line until the button takes over.
  const showBubble = !success && phase !== 'blank';
  const idle = showBubble && (phase === 'focused' || phase === 'inserted');
  // The bubble nudges only when someone has sat on a step for 9 s without tapping it.
  useEffect(() => {
    setNudge(false);
    if (!idle) return;
    const timer = setTimeout(() => setNudge(true), 9000);
    return () => clearTimeout(timer);
  }, [idle, phase]);
  const hint = error
    ? null
    : phase === 'listening'
      ? t('hintSaySomething')
      : phase === 'inserted'
        ? t('hintTapOutside')
        : phase === 'processing'
          ? ''
          : kind === 'message' && phase !== 'blank'
            ? t('hintTapBubble')
            : kind === 'message'
              ? ''
              : t(copy.start);

  return (
    <SafeAreaView style={s.page} edges={['top', 'bottom', 'left', 'right']}>
      <View ref={root} style={{ flex: 1 }} onLayout={() => place(anchorTop(keyboardTop))}>
        <Pressable style={{ flex: 1 }} onPress={() => Keyboard.dismiss()} accessible={false}>
          <View style={s.header}>
            <CircleButton icon="back" label={t('back')} onPress={onBack} />
            {kind !== 'message' || error ? (
              <PillButton label={t('skip')} onPress={onNext} />
            ) : (
              <View />
            )}
          </View>
          <View style={[s.content, { gap: 12 }]}>
            <View style={p.card}>
              <View style={p.cardHeader}>
                <Image source={ICONS[kind]} style={p.appIcon} />
                <Text style={p.appName}>{t(copy.app)}</Text>
                <View style={p.send}>
                  <SystemIcon
                    name="paperplane.fill"
                    mdName="SendHorizontal"
                    size={14}
                    color={colors.accent}
                  />
                </View>
              </View>
              <View>
                <TextInput
                  ref={input}
                  multiline
                  value={text}
                  onChangeText={setText}
                  placeholder={kind === 'message' && phase === 'blank' ? '' : t(copy.placeholder)}
                  placeholderTextColor={colors.tertiary}
                  accessibilityLabel={t(copy.placeholder)}
                  onFocus={() => {
                    setFocused(true);
                    if (phase === 'blank') setPhase('focused');
                  }}
                  onBlur={onBlur}
                  showSoftInputOnFocus
                  autoFocus={kind !== 'message'}
                  style={p.input}
                />
                {kind === 'message' && phase === 'blank' && !text ? (
                  <Pressable
                    cssInterop={false}
                    accessibilityRole="button"
                    accessibilityLabel={t('tapHere')}
                    onPress={() => input.current?.focus()}
                    style={[StyleSheet.absoluteFill, s.center]}
                  >
                    <Text style={{ fontSize: 17, color: colors.ink }}>{t('tapHere')}</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
            {error ? (
              <Text accessibilityRole="alert" style={[s.body, { color: '#B42318' }]}>
                {error}
              </Text>
            ) : null}
          </View>
        </Pressable>
        {kind !== 'message' || phase !== 'blank' ? (
          <View style={[p.overlay, { bottom: overlayBottom }]} pointerEvents="box-none">
            <View style={p.hintRow}>
              {success ? (
                <AccentText center text={t(copy.success)} style={[p.hint, p.hintCentered]} />
              ) : hint ? (
                <AccentText text={hint} style={p.hint} />
              ) : null}
            </View>
            {success ? (
              <GlassButton label={t(kind === 'message' ? 'continue' : 'next')} onPress={onNext} />
            ) : (
              <View style={p.bubbleRow}>
                {showBubble ? (
                  <PracticeBubble
                    state={bubbleState}
                    onPress={() => void start()}
                    onStop={() => void stop()}
                    onCancel={cancel}
                  />
                ) : null}
              </View>
            )}
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const p = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: colors.surface2,
  },
  appIcon: { width: 24, height: 24, borderRadius: 6 },
  appName: { flex: 1, fontSize: 16, fontFamily: AppFont.semibold, color: colors.ink },
  send: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    minHeight: 96,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 14,
    fontSize: 17,
    lineHeight: 24,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  overlay: { position: 'absolute', left: 16, right: 16, gap: 10 },
  hintRow: { minHeight: 26, justifyContent: 'flex-end' },
  bubbleRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    minHeight: 64,
    alignItems: 'center',
  },
  hint: { fontSize: 18, lineHeight: 24, textAlign: 'right', fontFamily: AppFont.medium },
  hintCentered: { textAlign: 'center' },
  hintDone: { fontSize: 20, lineHeight: 26, fontFamily: AppFont.medium },
});
