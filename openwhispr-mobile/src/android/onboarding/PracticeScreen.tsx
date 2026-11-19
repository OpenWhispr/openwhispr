import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text } from '@/components/ui/Text';
import { AndroidDictation } from '../../../modules/android-dictation/src';
import { CircleButton, GlassButton, PillButton, colors, s } from './kit';
import { PracticeBubble, type BubbleState } from './PracticeBubble';
import { AppCard, DoneLine, Hint, fieldText, useKeyboardAnchor } from './practiceParts';
import { PracticeRecorder, requestMicrophone } from './practiceRecorder';
import { useOnboardingT } from './strings';

/** P1a Tap here → focused → listening → writing → pasted ✓ → tap outside → done. */
type Phase = 'blank' | 'focused' | 'listening' | 'processing' | 'pasted' | 'done';

/**
 * Practice 1, dictate (onboarding v4, P1a–P1g): a WhatsApp card, tap the bubble, talk, and the
 * words land in the box. Tapping outside the box ends it, as the real bubble hides with the keyboard.
 */
export function PracticeScreen({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const t = useOnboardingT();
  const input = useRef<TextInput>(null);
  const recorder = useRef(new PracticeRecorder());
  const mounted = useRef(true);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>('blank');
  const [nudge, setNudge] = useState(false);
  const [error, setError] = useState('');
  // Closing the keyboard (back gesture) leaves the box focused; treat it as leaving the box.
  const anchor = useKeyboardAnchor(() => input.current?.blur());

  useEffect(() => {
    mounted.current = true;
    const current = recorder.current;
    const app = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && current.active) {
        void current.cancel();
        setPhase((value) => (value === 'listening' ? 'focused' : value));
      }
    });
    return () => {
      mounted.current = false;
      app.remove();
      void current.cancel();
    };
  }, []);

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
      const result = await recorder.current.finish();
      if (!mounted.current) return;
      setText(result);
      setPhase('pasted');
    } catch (failure) {
      if (!mounted.current) return;
      const message = (failure as Error).message;
      setError(/hear|speech/i.test(message) ? t('noSpeech') : t('practiceFailed', { message }));
      setPhase(text ? 'pasted' : 'focused');
    }
  };

  const cancel = () => {
    void recorder.current.cancel();
    setPhase(text ? 'pasted' : 'focused');
  };

  const onBlur = () => {
    if (recorder.current.active) cancel();
    if (text && phase === 'pasted') {
      Keyboard.dismiss();
      setPhase('done');
    }
  };

  const idle = phase === 'focused';
  // The bubble nudges only when someone has sat on a step for 9 s without tapping it.
  useEffect(() => {
    setNudge(false);
    if (!idle) return;
    const timer = setTimeout(() => setNudge(true), 9000);
    return () => clearTimeout(timer);
  }, [idle]);

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
  const hint = error
    ? ''
    : phase === 'focused'
      ? t('hintTapBubble')
      : phase === 'listening'
        ? t('hintSaySomething')
        : phase === 'pasted'
          ? t('hintTapOutside')
          : '';
  const done = phase === 'done';

  return (
    <SafeAreaView style={s.page} edges={['top', 'bottom', 'left', 'right']}>
      <View ref={anchor.root} style={{ flex: 1 }} onLayout={anchor.onLayout}>
        <Pressable style={{ flex: 1 }} onPress={() => Keyboard.dismiss()} accessible={false}>
          <View style={s.header}>
            <CircleButton icon="back" label={t('back')} onPress={onBack} />
            {error && !done ? <PillButton label={t('skip')} onPress={onNext} /> : <View />}
          </View>
          <View style={[s.content, { gap: 12 }]}>
            <AppCard app="whatsapp">
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
                    onChangeText={setText}
                    placeholder={phase === 'blank' ? '' : t('messagePlaceholder')}
                    placeholderTextColor={colors.tertiary}
                    accessibilityLabel={t('messagePlaceholder')}
                    onFocus={() => setPhase((value) => (value === 'blank' ? 'focused' : value))}
                    onBlur={onBlur}
                    showSoftInputOnFocus
                    style={fieldText}
                  />
                )}
                {phase === 'blank' && !text ? (
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
            </AppCard>
            {error ? (
              <Text accessibilityRole="alert" style={[s.body, { color: '#B42318' }]}>
                {error}
              </Text>
            ) : null}
            {done ? <DoneLine text={t('dictateDone')} /> : null}
          </View>
        </Pressable>
        {done ? (
          <View style={s.footer}>
            <GlassButton label={t('continue')} onPress={onNext} />
          </View>
        ) : phase !== 'blank' ? (
          <View style={[pr.overlay, { bottom: anchor.overlayBottom }]} pointerEvents="box-none">
            <View style={pr.bubbleRow} pointerEvents="box-none">
              {/* "Now tap outside the box" must not catch the tap it asks for. */}
              <View style={{ flex: 1 }} pointerEvents="none">
                {hint ? <Hint text={hint} /> : null}
              </View>
              <PracticeBubble
                state={bubbleState}
                onPress={() => {
                  if (phase === 'focused') void start();
                }}
                onStop={() => void stop()}
                onCancel={cancel}
              />
            </View>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const pr = StyleSheet.create({
  overlay: { position: 'absolute', left: 16, right: 16 },
  bubbleRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64 },
});
