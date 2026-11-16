import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
  Image,
  Keyboard,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type KeyboardEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { AccentText, CircleButton, GlassButton, PillButton, colors, s } from './kit';
import { PracticeBubble, type BubbleState } from './PracticeBubble';
import { PracticeRecorder, requestMicrophone } from './practiceRecorder';
import { useOnboardingT, type OnboardingKey } from './strings';

export type PracticeKind = 'message' | 'email' | 'list';

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
  const [used, setUsed] = useState(false);
  const [error, setError] = useState('');
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [overlayBottom, setOverlayBottom] = useState(16);

  const place = useCallback((top: number | null) => {
    if (top === null) return;
    root.current?.measureInWindow((_x, y, _w, height) => {
      if (mounted.current) setOverlayBottom(Math.max(12, y + height - top + 12));
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const show = Keyboard.addListener('keyboardDidShow', (event: KeyboardEvent) => {
      setKeyboardTop(event.endCoordinates.screenY);
      place(event.endCoordinates.screenY);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardTop(null));
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
      setUsed(true);
      setPhase('listening');
    } catch (failure) {
      setError(t('practiceFailed', { message: (failure as Error).message }));
    }
  };

  const stop = async () => {
    setPhase('processing');
    try {
      const result = await recorder.current.finish();
      if (!mounted.current) return;
      setText(result.trim());
      if (kind === 'message') setPhase('inserted');
      else {
        setPhase('done');
        Keyboard.dismiss();
      }
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

  const busy = phase === 'listening' || phase === 'processing';
  const bubbleState: BubbleState =
    phase === 'listening'
      ? 'listening'
      : phase === 'processing'
        ? 'processing'
        : used
          ? 'idle'
          : 'pulsing';
  const showBubble = focused && keyboardTop !== null && !success;
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
      <View ref={root} style={{ flex: 1 }} onLayout={() => place(keyboardTop)}>
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
              {kind === 'email' ? (
                <>
                  <View style={p.field}>
                    <Text style={p.label}>{t('to')}</Text>
                    <View style={p.chip}>
                      <View style={p.avatar}>
                        <Text style={{ fontSize: 11, color: colors.accent, fontWeight: '600' }}>
                          {t('emailRecipient').slice(0, 1)}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 15, color: colors.ink }}>{t('emailRecipient')}</Text>
                    </View>
                  </View>
                  <View style={p.field}>
                    <Text style={p.label}>{t('subject')}</Text>
                    <Text style={p.value}>{t('emailSubject')}</Text>
                  </View>
                </>
              ) : null}
              {kind === 'list' ? (
                <View style={p.field}>
                  <Text style={p.label}>{t('title')}</Text>
                  <Text style={p.value}>{t('listTitle')}</Text>
                </View>
              ) : null}
              <View>
                <TextInput
                  ref={input}
                  multiline
                  value={text}
                  onChangeText={setText}
                  editable={!busy}
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
        {success ? (
          <View style={s.footer}>
            <AccentText center text={t(copy.success)} style={p.hintDone} />
            <GlassButton
              label={t(kind === 'message' ? 'continue' : 'next')}
              onPress={onNext}
              style={{ marginTop: 12 }}
            />
          </View>
        ) : null}
        {showBubble ? (
          <View style={[p.overlay, { bottom: overlayBottom }]} pointerEvents="box-none">
            {hint ? <AccentText text={hint} style={p.hint} /> : <View style={{ flex: 1 }} />}
            <PracticeBubble
              state={bubbleState}
              onPress={() => void start()}
              onStop={() => void stop()}
              onCancel={cancel}
            />
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
  appName: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.ink },
  send: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    minHeight: 44,
    borderBottomWidth: 1,
    borderColor: colors.divider,
  },
  label: { fontSize: 15, color: colors.tertiary },
  value: { fontSize: 15, color: colors.ink, fontWeight: '500' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.fill,
    borderRadius: 14,
    paddingLeft: 3,
    paddingRight: 10,
    paddingVertical: 3,
  },
  avatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    minHeight: 120,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 14,
    fontSize: 17,
    lineHeight: 24,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  overlay: {
    position: 'absolute',
    left: 16,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 12,
  },
  hint: { flex: 1, fontSize: 18, lineHeight: 24, textAlign: 'right', fontWeight: '500' },
  hintDone: { fontSize: 20, lineHeight: 26, fontWeight: '500' },
});
