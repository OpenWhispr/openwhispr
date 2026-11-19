import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { safeHaptics } from '@/lib/utils';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { CircleButton, GlassButton, PillButton, colors, s } from './kit';
import { PracticeBubble, type BubbleState } from './PracticeBubble';
import {
  AppCard,
  DoneLine,
  Hint,
  PracticeMenu,
  SayCard,
  fieldText,
  useKeyboardAnchor,
} from './practiceParts';
import { diffWords, type DiffRun } from './practiceDiff';
import { PracticeRecorder, requestMicrophone } from './practiceRecorder';
import { useOnboardingT, type OnboardingKey } from './strings';

export type MenuPractice = 'assistant' | 'edit';

/**
 * select (edit only) → hold → holding (ring fills) → menu (coach tag on the row) → listening (Say
 * card) → processing → pasted (✓) → done (keyboard down, the done line, Next).
 */
type Phase =
  | 'select'
  | 'hold'
  | 'holding'
  | 'menu'
  | 'listening'
  | 'processing'
  | 'pasted'
  | 'done';

// How long the ✓ stays on the pasted result before the practice moves on. No Undo toast: the real
// bubble shows none after Assistant or Edit selection, so the practice doesn't either (Josh, 20 Nov).
const PASTED_MS = 2500;

// The email Practice 2 wrote; Practice 3 edits it.
let writtenEmail = '';

const COPY: Record<
  MenuPractice,
  { say?: OnboardingKey; done: OnboardingKey; hold: OnboardingKey }
> = {
  assistant: {
    say: 'assistantScript',
    done: 'assistantDone',
    hold: 'hintHoldBubble',
  },
  // Practice 3 says what to say in the guidance line beside the bubble, as Practice 1 does (P3d).
  edit: { done: 'editDone', hold: 'hintHoldToEdit' },
};

/**
 * Practices 2 and 3 (onboarding v4, P2a–P2g and P3a–P3g). Both teach the bubble's hold menu in a
 * Gmail card: Practice 2 holds, picks Assistant and asks for an email, which pastes into the card;
 * Practice 3 selects that email, holds, picks Edit selection and says the change, and only the
 * selection is rewritten, its new words blue and underlined. Both run the bubble's own pipeline.
 */
export function PracticeMenuScreen({
  kind,
  onBack,
  onNext,
}: {
  kind: MenuPractice;
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useOnboardingT();
  const copy = COPY[kind];
  const language = useConfigStore(
    (state) => state.config?.androidTranslationTarget?.label ?? 'Spanish',
  );
  const input = useRef<TextInput>(null);
  const recorder = useRef(new PracticeRecorder());
  const mounted = useRef(true);
  const [text, setText] = useState(() =>
    kind === 'edit' ? writtenEmail || t('editEmailSample') : '',
  );
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [phase, setPhase] = useState<Phase>(kind === 'edit' ? 'select' : 'hold');
  const [runs, setRuns] = useState<{ start: number; end: number; runs: DiffRun[] } | null>(null);
  const [nudge, setNudge] = useState(false);
  const [error, setError] = useState('');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const anchor = useKeyboardAnchor(() => {
    if (phaseRef.current === 'pasted') finish();
  });
  const selected = selection.end > selection.start;

  useEffect(() => {
    mounted.current = true;
    const current = recorder.current;
    const app = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && current.active) {
        void current.cancel();
        setPhase(kind === 'edit' ? 'select' : 'hold');
      }
    });
    return () => {
      mounted.current = false;
      app.remove();
      void current.cancel();
    };
  }, [kind]);

  // Practice 3: selecting text moves on to the hold; clearing the selection goes back.
  useEffect(() => {
    if (kind !== 'edit') return;
    if (phase === 'select' && selected) setPhase('hold');
    if ((phase === 'hold' || phase === 'holding' || phase === 'menu') && !selected)
      setPhase('select');
  }, [kind, phase, selected]);

  // A tap instead of a hold, or 9 s sitting still, makes the bubble pulse.
  useEffect(() => {
    setNudge(false);
    if (phase !== 'hold') return;
    const timer = setTimeout(() => setNudge(true), 9000);
    return () => clearTimeout(timer);
  }, [phase]);

  // The practice ends 2.5 s after the paste, or sooner on a tap outside.
  useEffect(() => {
    if (phase !== 'pasted') return;
    const timer = setTimeout(finish, PASTED_MS);
    return () => clearTimeout(timer);
    // `finish` only reads refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function finish() {
    if (phaseRef.current !== 'pasted') return;
    Keyboard.dismiss();
    setPhase('done');
  }

  const restart = () => setPhase(kind === 'edit' ? (selected ? 'hold' : 'select') : 'hold');

  const pick = async () => {
    setError('');
    safeHaptics('selection');
    const access = await requestMicrophone();
    if (access !== 'granted') {
      Alert.alert(t('micNeededTitle'), t('micNeededBody'), [
        { text: t('cancel'), style: 'cancel' },
        ...(access === 'blocked'
          ? [{ text: t('openSettings'), onPress: () => AndroidDictation?.openSettings('app') }]
          : []),
      ]);
      restart();
      return;
    }
    try {
      await recorder.current.start();
      setPhase('listening');
    } catch (failure) {
      setError(t('practiceFailed', { message: (failure as Error).message }));
      restart();
    }
  };

  const stop = async () => {
    setPhase('processing');
    const { start, end } = selection;
    try {
      if (kind === 'assistant') {
        const email = await recorder.current.finishWrite();
        if (!mounted.current) return;
        setText(email);
        writtenEmail = email;
      } else {
        const original = text.slice(start, end);
        const replacement = await recorder.current.finishEdit(original, language);
        if (!mounted.current) return;
        setText(text.slice(0, start) + replacement + text.slice(end));
        setRuns({ start, end: start + replacement.length, runs: diffWords(original, replacement) });
      }
      setPhase('pasted');
      safeHaptics('success');
    } catch (failure) {
      if (!mounted.current) return;
      const message = (failure as Error).message;
      setError(/hear|speech/i.test(message) ? t('noSpeech') : t('practiceFailed', { message }));
      restart();
    }
  };

  const cancel = () => {
    void recorder.current.cancel();
    restart();
  };

  const bubbleState: BubbleState =
    phase === 'listening'
      ? 'listening'
      : phase === 'processing'
        ? 'processing'
        : phase === 'pasted'
          ? 'pasted'
          : nudge
            ? 'pulsing'
            : 'idle';
  const canHold = phase === 'hold' || phase === 'holding';
  const hint = error
    ? ''
    : phase === 'select'
      ? t('hintSelectEmail')
      : phase === 'hold'
        ? t(copy.hold)
        : phase === 'holding'
          ? t('hintKeepHolding')
          : phase === 'listening' && kind === 'edit'
            ? t('hintSayFriendlier')
            : '';
  const done = phase === 'done';
  // The new words stay marked while the ✓ shows; the done step shows the email plain (P3g).
  const highlighted = phase === 'pasted' && runs;

  return (
    <SafeAreaView style={s.page} edges={['top', 'bottom', 'left', 'right']}>
      <View ref={anchor.root} style={{ flex: 1 }} onLayout={anchor.onLayout}>
        <Pressable
          style={{ flex: 1 }}
          onPress={() => {
            if (phase === 'menu') restart();
            else if (phase === 'pasted') finish();
          }}
          accessible={false}
        >
          <View style={s.header}>
            <CircleButton icon="back" label={t('back')} onPress={onBack} />
            <PillButton label={t('skip')} onPress={onNext} />
          </View>
          <View style={[s.content, { gap: 12 }]}>
            <AppCard app="gmail">
              <View>
                {done ? (
                  // The done step shows the text, not a read-only field: Android drops a read-only
                  // field's padding, which pushed the text to the card's edge (Josh, 20 Nov).
                  <Text style={fieldText}>{text}</Text>
                ) : (
                  <TextInput
                    ref={input}
                    multiline
                    value={text}
                    onChangeText={(value) => {
                      setText(value);
                      setRuns(null);
                    }}
                    onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
                    placeholder={t('emailPlaceholder')}
                    placeholderTextColor={colors.tertiary}
                    accessibilityLabel={t('appGmail')}
                    autoFocus
                    showSoftInputOnFocus
                    // Read-only would close the keyboard; the board keeps it up while listening and writing.
                    // While Practice 3's result shows, the field stays mounted and focused but out of
                    // sight, so the keyboard stays up under the marked copy below.
                    style={highlighted ? pm.hiddenInput : fieldText}
                  />
                )}
                {highlighted ? (
                  <Text style={fieldText} accessibilityLiveRegion="polite">
                    {text.slice(0, runs.start)}
                    {runs.runs.map((run, index) => (
                      <Text key={index} style={run.changed ? pm.changed : undefined}>
                        {run.text}
                      </Text>
                    ))}
                    {text.slice(runs.end)}
                  </Text>
                ) : null}
              </View>
            </AppCard>
            {error ? (
              <Text accessibilityRole="alert" style={[s.body, { color: '#B42318' }]}>
                {error}
              </Text>
            ) : null}
            {done ? <DoneLine text={t(copy.done)} /> : null}
          </View>
        </Pressable>
        {done ? (
          <View style={s.footer}>
            <GlassButton label={t(kind === 'edit' ? 'continue' : 'next')} onPress={onNext} />
          </View>
        ) : (
          <View style={[pm.overlay, { bottom: anchor.overlayBottom }]} pointerEvents="box-none">
            {phase === 'menu' ? (
              <PracticeMenu
                target={kind === 'edit' ? 'edit' : 'assistant'}
                language={language}
                offsetX={16}
                onPick={() => void pick()}
                onClose={restart}
              />
            ) : null}
            {(phase === 'listening' || phase === 'processing') && copy.say ? (
              <SayCard quote={copy.say} />
            ) : null}
            <View style={pm.bubbleRow} pointerEvents="box-none">
              <View
                style={{ flex: 1, alignItems: 'flex-end' }}
                // The guidance never takes a tap meant for the screen behind it.
                pointerEvents="none"
              >
                {hint ? <Hint text={hint} /> : null}
              </View>
              <PracticeBubble
                state={bubbleState}
                badge={
                  phase === 'listening' || phase === 'processing'
                    ? kind === 'edit'
                      ? 'pencil'
                      : 'sparkle'
                    : undefined
                }
                // A tap closes the menu; otherwise the step is about holding, so it nudges.
                onPress={() => {
                  if (phase === 'menu') restart();
                  else if (phase === 'hold') setNudge(true);
                }}
                onHoldStart={() => setPhase('holding')}
                onHoldCancel={() => setPhase((value) => (value === 'holding' ? 'hold' : value))}
                onHold={
                  canHold
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
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const pm = StyleSheet.create({
  changed: { color: colors.brandMid, textDecorationLine: 'underline' },
  hiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  overlay: { position: 'absolute', left: 16, right: 16, gap: 10 },
  bubbleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 },
});
