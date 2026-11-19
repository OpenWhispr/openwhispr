import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { safeHaptics } from '@/lib/utils';
import { gloss, glossPressed, home, type } from '../home/kit';
import { showToast, useReduceMotion } from '../settings/kit';
import { edgeCard } from '../settings/look';
import { Field } from './Field';
import { learnCorrections } from './learned';
import { showLearnedToast } from './learnedToast';
import { fixWordInTranscript } from './transcriptFix';
import { dictionaryT, useDictionaryT } from './strings';

export type FixTarget = {
  word: string;
  /** Where the long-press landed, in window coordinates. */
  x: number;
  y: number;
  /** How many times the word appears in this transcript. */
  count: number;
};

const CARD_WIDTH = 320;
const CARD_HEIGHT = 156;

/**
 * C10: fixes every mention in the transcript and teaches the dictionary the right spelling,
 * then the C7 toast says so with Undo. Undo of the learning leaves the fixed text as it is.
 */
export function applyTranscriptFix(
  note: { id: number; title: string },
  from: string,
  to: string,
): void {
  const fixed = fixWordInTranscript(note.id, from, to);
  const learned = learnCorrections([{ word: to, from }], {
    kind: 'transcript',
    noteId: note.id,
    title: note.title,
  });
  if (learned.length > 0) showLearnedToast(learned, { fixedCount: fixed });
  else if (fixed > 0) showToast(dictionaryT('saved'));
}

/**
 * C9: long-press a misheard word in a transcript, type the fix, Save. The card grows from the
 * word (200 ms) and sits below it, or above it near the bottom of the screen.
 */
export function FixWordCard({
  target,
  onClose,
  onSave,
}: {
  target: FixTarget | null;
  onClose: () => void;
  onSave: (from: string, to: string) => void;
}) {
  const t = useDictionaryT();
  const reduceMotion = useReduceMotion();
  const { width, height } = useWindowDimensions();
  const [shown, setShown] = useState<FixTarget | null>(target);
  const [value, setValue] = useState('');
  const grow = useRef(new Animated.Value(0)).current;
  const field = useRef<TextInput>(null);
  useEffect(() => {
    if (!target) return;
    setShown(target);
    setValue(target.word);
    grow.setValue(reduceMotion ? 1 : 0);
    Animated.timing(grow, {
      toValue: 1,
      duration: reduceMotion ? 0 : 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    const timer = setTimeout(() => field.current?.focus(), 220);
    return () => clearTimeout(timer);
  }, [target, grow, reduceMotion]);
  if (!target || !shown) return null;

  const cardWidth = Math.min(CARD_WIDTH, width - 32);
  const left = Math.max(16, Math.min(shown.x - cardWidth / 2, width - cardWidth - 16));
  const below = shown.y + 20;
  // Near the bottom the keyboard would cover it, so it opens above the word instead.
  const top = below + CARD_HEIGHT > height * 0.6 ? Math.max(16, shown.y - CARD_HEIGHT - 16) : below;
  const next = value.trim();
  const ready = next !== '' && next !== shown.word;
  const save = () => {
    if (!ready) return;
    safeHaptics('success');
    onSave(shown.word, next);
    onClose();
  };

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('cancel')}
        onPress={onClose}
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
      />
      <Animated.View
        style={[
          edgeCard,
          {
            position: 'absolute',
            top,
            left,
            width: cardWidth,
            padding: 14,
            gap: 12,
            boxShadow: home.floatingShadow,
            opacity: grow,
            transform: [{ scale: grow.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }],
          },
        ]}
      >
        <Text style={[type.footnote, { fontWeight: '500' }]}>
          {t('fixWordTitle', { word: shown.word })}
        </Text>
        <Field
          inputRef={field}
          value={value}
          onChangeText={setValue}
          accessibilityLabel={t('fixWordTitle', { word: shown.word })}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={save}
        />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Text style={[type.footnote, { flex: 1 }]}>
            {shown.count > 1 ? t('fixAllAdd', { count: shown.count }) : t('fixOneAdd')}
          </Text>
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityState={{ disabled: !ready }}
            disabled={!ready}
            onPress={save}
            style={({ pressed }) => [
              {
                minHeight: 40,
                paddingHorizontal: 18,
                borderRadius: 999,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: ready ? 1 : 0.5,
              },
              gloss,
              pressed && ready && glossPressed,
            ]}
          >
            <Text style={{ color: '#FFFFFF', fontSize: 15, lineHeight: 20, fontWeight: '500' }}>
              {t('save')}
            </Text>
          </Pressable>
        </View>
      </Animated.View>
    </Modal>
  );
}
