import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  AppState,
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
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useConfigStore } from '@/store/useConfigStore';
import { safeHaptics } from '@/lib/utils';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { AccentText, CircleButton, GlassButton, PillButton, colors, s } from './kit';
import { Glyph, PracticeBubble, type GlyphName } from './PracticeBubble';
import { PracticeRecorder, requestMicrophone } from './practiceRecorder';
import { anchorTop, rememberedPracticeEmail } from './PracticeScreen';
import { useOnboardingT, type OnboardingKey } from './strings';

/** select the email → hold the bubble → pick Edit selection → say the change → edited. */
type Phase = 'select' | 'hold' | 'menu' | 'listening' | 'processing' | 'done';

const GMAIL = require('./assets/apps/gmail.png');

/**
 * Practice 4, "Edit with the assistant" (onboarding board 5247:4268 → 5247:4901). It reuses the email
 * from Practice 2 and teaches the bubble's hold menu: select the text, hold the bubble, pick Edit
 * selection, say the change, and only the selection is replaced. Skippable, like the other practices.
 */
export function PracticeEditScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  const target = useConfigStore(
    (state) => state.config?.androidTranslationTarget?.label ?? 'Spanish',
  );
  const recorder = useRef(new PracticeRecorder());
  const root = useRef<View>(null);
  const mounted = useRef(true);
  const [text, setText] = useState(() => rememberedPracticeEmail() || t('editEmailSample'));
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [phase, setPhase] = useState<Phase>('select');
  const [edited, setEdited] = useState<{ start: number; end: number } | null>(null);
  const [error, setError] = useState('');
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [overlayBottom, setOverlayBottom] = useState(16);
  const selected = selection.end > selection.start;

  const place = useCallback((top: number | null) => {
    if (top === null) return;
    root.current?.measureInWindow((_x, y, _w, height) => {
      const bottom = y + height + (StatusBar.currentHeight ?? 0);
      if (mounted.current) setOverlayBottom(Math.max(12, bottom - top + 12));
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
        setPhase('hold');
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
  }, [place]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => place(anchorTop(keyboardTop)));
    return () => cancelAnimationFrame(frame);
  }, [keyboardTop, place]);

  // Selecting text moves on to the hold; clearing it goes back.
  useEffect(() => {
    if (phase === 'select' && selected) setPhase('hold');
    if ((phase === 'hold' || phase === 'menu') && !selected) setPhase('select');
  }, [phase, selected]);

  const pickEdit = async () => {
    setError('');
    const access = await requestMicrophone();
    if (access !== 'granted') {
      Alert.alert(t('micNeededTitle'), t('micNeededBody'), [
        { text: t('cancel'), style: 'cancel' },
        ...(access === 'blocked'
          ? [{ text: t('openSettings'), onPress: () => AndroidDictation?.openSettings('app') }]
          : []),
      ]);
      setPhase('hold');
      return;
    }
    try {
      await recorder.current.start();
      setPhase('listening');
    } catch (failure) {
      setError(t('practiceFailed', { message: (failure as Error).message }));
      setPhase('hold');
    }
  };

  const stop = async () => {
    setPhase('processing');
    const { start, end } = selection;
    try {
      const replacement = await recorder.current.finishEdit(text.slice(start, end), target);
      if (!mounted.current) return;
      setText(text.slice(0, start) + replacement + text.slice(end));
      setEdited({ start, end: start + replacement.length });
      setPhase('done');
      safeHaptics('success');
    } catch (failure) {
      if (!mounted.current) return;
      const message = (failure as Error).message;
      setError(/hear|speech/i.test(message) ? t('noSpeech') : t('practiceFailed', { message }));
      setPhase('hold');
    }
  };

  const cancel = () => {
    void recorder.current.cancel();
    setPhase('hold');
  };

  const hint: { main: string; sub?: string } | null = error
    ? null
    : phase === 'select'
      ? { main: t('hintSelectEmail') }
      : phase === 'hold'
        ? { main: t('hintHoldBubble') }
        : phase === 'menu'
          ? { main: t('hintPickEdit') }
          : phase === 'listening'
            ? { main: t('hintSayFriendlier'), sub: t('hintThenTap') }
            : phase === 'done'
              ? { main: t('hintEditDone') }
              : null;

  return (
    <SafeAreaView style={s.page} edges={['top', 'bottom', 'left', 'right']}>
      <View ref={root} style={{ flex: 1 }} onLayout={() => place(anchorTop(keyboardTop))}>
        <View style={s.header}>
          <CircleButton icon="back" label={t('back')} onPress={onBack} />
          <PillButton label={t('skip')} onPress={onNext} />
        </View>
        <View style={[s.content, { gap: 12 }]}>
          <View style={p.card}>
            <View style={p.cardHeader}>
              <Image source={GMAIL} style={p.appIcon} />
              <Text style={p.appName}>{t('appGmail')}</Text>
              <View style={p.send}>
                <SystemIcon
                  name="paperplane.fill"
                  mdName="SendHorizontal"
                  size={14}
                  color={colors.accent}
                />
              </View>
            </View>
            {phase === 'done' && edited ? (
              // Only the selection was replaced; the new words show brand blue and underlined.
              <Text style={p.input} accessibilityLiveRegion="polite">
                {text.slice(0, edited.start)}
                <Text style={p.edited}>{text.slice(edited.start, edited.end)}</Text>
                {text.slice(edited.end)}
              </Text>
            ) : (
              <TextInput
                multiline
                value={text}
                onChangeText={setText}
                onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
                accessibilityLabel={t('appGmail')}
                autoFocus
                showSoftInputOnFocus
                editable={phase !== 'processing'}
                style={p.input}
              />
            )}
          </View>
          {error ? (
            <Text accessibilityRole="alert" style={[s.body, { color: '#B42318' }]}>
              {error}
            </Text>
          ) : null}
        </View>
        <View style={[p.overlay, { bottom: overlayBottom }]} pointerEvents="box-none">
          <View style={p.hintRow}>
            {hint ? (
              <View style={{ alignItems: phase === 'done' ? 'center' : 'flex-end' }}>
                <AccentText
                  text={hint.main}
                  center={phase === 'done'}
                  style={[p.hint, phase === 'done' && { textAlign: 'center' }]}
                />
                {hint.sub ? <Text style={p.sub}>{hint.sub}</Text> : null}
              </View>
            ) : null}
          </View>
          {phase === 'menu' ? (
            <PracticeMenu
              target={target}
              onEdit={() => void pickEdit()}
              onClose={() => setPhase('hold')}
            />
          ) : null}
          {phase === 'done' ? (
            <GlassButton label={t('next')} onPress={onNext} />
          ) : (
            <View style={p.bubbleRow}>
              <PracticeBubble
                state={
                  phase === 'listening'
                    ? 'listening'
                    : phase === 'processing'
                      ? 'processing'
                      : 'idle'
                }
                badge={phase === 'listening' || phase === 'processing' ? 'pencil' : undefined}
                // In this practice a tap only closes the menu: the step is about holding.
                onPress={() => {
                  if (phase === 'menu') setPhase('hold');
                }}
                onHold={
                  selected && (phase === 'hold' || phase === 'select')
                    ? () => {
                        safeHaptics('selection');
                        setPhase('menu');
                      }
                    : undefined
                }
                onStop={() => void stop()}
                onCancel={cancel}
              />
            </View>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}

const ROWS: { glyph: GlyphName; title: OnboardingKey; body: OnboardingKey; edit?: boolean }[] = [
  { glyph: 'sparkle', title: 'menuAssistant', body: 'menuAssistantBody' },
  { glyph: 'globe', title: 'menuTranslate', body: 'menuTranslateBody' },
  { glyph: 'pencil', title: 'menuEdit', body: 'menuEditBody', edit: true },
];

/** V3/Menu as the bubble draws it. Only Edit selection is live in this practice. */
function PracticeMenu({
  target,
  onEdit,
  onClose,
}: {
  target: string;
  onEdit: () => void;
  onClose: () => void;
}) {
  const t = useOnboardingT();
  return (
    <Animated.View
      entering={ZoomIn.duration(220)}
      exiting={FadeOut.duration(160)}
      style={p.menuWrap}
    >
      <Pressable cssInterop={false} onPress={onClose} accessible={false} style={p.menu}>
        {ROWS.map((row) => (
          <Pressable
            key={row.title}
            cssInterop={false}
            accessibilityRole="button"
            accessibilityState={{ disabled: !row.edit }}
            onPress={row.edit ? onEdit : undefined}
            style={[p.row, row.edit && p.rowHighlight]}
          >
            <View style={p.tile}>
              <Glyph name={row.glyph} size={14} color={colors.ink} />
            </View>
            <Animated.View entering={FadeIn.delay(40).duration(120)} style={{ flex: 1 }}>
              <Text style={p.rowTitle}>{t(row.title)}</Text>
              <Text style={p.rowBody}>{t(row.body, { language: target })}</Text>
            </Animated.View>
          </Pressable>
        ))}
      </Pressable>
    </Animated.View>
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
    paddingVertical: 14,
    fontSize: 17,
    lineHeight: 24,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  edited: { color: colors.brandMid, textDecorationLine: 'underline' },
  overlay: { position: 'absolute', left: 16, right: 16, gap: 10 },
  hintRow: { minHeight: 26, justifyContent: 'flex-end' },
  hint: { fontSize: 18, lineHeight: 24, textAlign: 'right', fontFamily: AppFont.medium },
  sub: { fontSize: 14, color: colors.secondary, textAlign: 'right', marginTop: 2 },
  bubbleRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    minHeight: 64,
    alignItems: 'center',
  },
  menuWrap: { alignSelf: 'flex-end', transformOrigin: 'bottom right' },
  menu: {
    width: 208,
    padding: 6,
    gap: 2,
    borderRadius: 20,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  row: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 8,
    paddingRight: 10,
    borderRadius: 14,
  },
  rowHighlight: { backgroundColor: 'rgba(21,75,212,0.12)' },
  tile: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: '#F2F1EF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: 14, fontFamily: AppFont.medium, color: '#181714' },
  rowBody: { fontSize: 12, color: '#6E6D69' },
});
