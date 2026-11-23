import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/lib/utils';
import type { DictionaryEntry } from '@/store/useDictionaryStore';
import { PillButton, type } from '../home/kit';
import { showToast, useReduceMotion } from '../settings/kit';
import { flat, theme } from '../theme';
import { SectionLabel } from '../notes/look';
import { UNDO_MS } from './learnedToast';
import { keepLearned, restoreLearned, unlearn, type LearnedInfo } from './learned';
import { sinceLearned } from './time';
import { dictionaryT, useDictionaryT } from './strings';

type Item = DictionaryEntry & { info: LearnedInfo };

const CARD_RADIUS = 16;
/** How far each card behind shows below the one in front, and how far in its sides sit. */
const PEEK = 12;
const INSET = [10, 22];

function fixedLine(item: Item, language: string): string {
  const time = sinceLearned(item.info.learnedAt, language);
  const from = item.info.from;
  if (!from) return dictionaryT('learnedAgo', { time });
  if (item.info.origin.kind === 'note') return dictionaryT('youFixedInNote', { from, time });
  if (item.info.origin.kind === 'transcript')
    return dictionaryT('youFixedInTranscript', { from, time });
  return dictionaryT('youFixedInApp', { from, time });
}

function decide(item: Item, keep: boolean) {
  safeHaptics(keep ? 'success' : 'light');
  if (keep) {
    keepLearned(item.word);
    return;
  }
  unlearn([item.word]);
  let settled = false;
  showToast(
    dictionaryT('removed', { word: item.word }),
    'success',
    {
      label: dictionaryT('undo'),
      onPress: () => {
        if (settled) return;
        settled = true;
        restoreLearned(item.word, item.info);
      },
      onClose: () => {
        settled = true;
      },
    },
    { durationMs: UNDO_MS, aboveTabBar: true },
  );
}

/** The card on top: follows the finger, tilts up to 6°, and flies off past a third. */
function TopCard({
  item,
  entering,
  onHeight,
}: {
  item: Item;
  entering: boolean;
  onHeight: (height: number) => void;
}) {
  const t = useDictionaryT();
  const { i18n } = useTranslation();
  const reduceMotion = useReduceMotion();
  const [width, setWidth] = useState(360);
  const x = useSharedValue(0);
  const scale = useSharedValue(entering && !reduceMotion ? 0.96 : 1);
  useEffect(() => {
    scale.value = withTiming(1, { duration: reduceMotion ? 0 : 200 });
  }, [reduceMotion, scale]);

  const fly = (keep: boolean) => {
    if (reduceMotion) {
      decide(item, keep);
      return;
    }
    x.value = withTiming(
      keep ? width * 1.3 : -width * 1.3,
      { duration: 240, easing: Easing.out(Easing.cubic) },
      () => runOnJS(decide)(item, keep),
    );
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-10, 10])
    .onUpdate((event) => {
      x.value = event.translationX;
    })
    .onEnd((event) => {
      const past = Math.abs(x.value) > width / 3 || Math.abs(event.velocityX) > 900;
      if (!past) {
        x.value = withTiming(0, { duration: 180 });
        return;
      }
      const keep = x.value > 0;
      x.value = withTiming(
        keep ? width * 1.3 : -width * 1.3,
        { duration: 240, easing: Easing.out(Easing.cubic) },
        () => runOnJS(decide)(item, keep),
      );
    });

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value },
      { rotate: `${interpolate(x.value, [-width, 0, width], [-6, 0, 6])}deg` },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        onLayout={(event) => {
          setWidth(event.nativeEvent.layout.width);
          onHeight(event.nativeEvent.layout.height);
        }}
        accessibilityActions={[
          { name: 'keep', label: t('keep') },
          { name: 'remove', label: t('remove') },
        ]}
        onAccessibilityAction={(event) => fly(event.nativeEvent.actionName === 'keep')}
        style={[flat, { borderRadius: CARD_RADIUS, padding: 14, gap: 14 }, style]}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              backgroundColor: theme.selFill,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <SystemIcon name="sparkles" mdName="Sparkles" size={18} color={theme.accent} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text
              numberOfLines={1}
              style={{ fontSize: 20, lineHeight: 26, fontWeight: '500', color: theme.ink }}
            >
              {item.word}
            </Text>
            <Text numberOfLines={2} style={type.footnote}>
              {fixedLine(item, i18n.language)}
            </Text>
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <PillButton label={t('remove')} onPress={() => fly(false)} />
          <PillButton label={t('keep')} onPress={() => fly(true)} />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * C1: words learned from the person's fixes wait on top as a small stack, one at a time.
 * Keep makes it one of their words; Remove deletes it and never learns it again. Ignoring the
 * stack is fine: the words already work.
 */
export function ReviewStack({ items }: { items: Item[] }) {
  const t = useDictionaryT();
  const [first, setFirst] = useState(items[0]?.word);
  const [cardHeight, setCardHeight] = useState(0);
  const top = items[0];
  const entering = first !== top?.word;
  useEffect(() => {
    if (top) setFirst(top.word);
  }, [top]);
  if (!top) return null;
  const behind = Math.min(items.length - 1, 2);
  return (
    <View style={{ gap: 10 }}>
      <SectionLabel label={t('learnedFromFixes', { count: items.length })} />
      <View style={{ paddingBottom: behind * PEEK }}>
        {/* Whole cards tucked behind the front one, so only their rounded bottoms show. */}
        {cardHeight > 0 &&
          Array.from({ length: behind }, (_, index) => behind - index).map((depth) => (
            <View
              key={depth}
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              style={[
                flat,
                {
                  position: 'absolute',
                  top: PEEK * depth,
                  left: INSET[depth - 1],
                  right: INSET[depth - 1],
                  height: cardHeight,
                  borderRadius: CARD_RADIUS,
                },
              ]}
            />
          ))}
        <TopCard key={top.word} item={top} entering={entering} onHeight={setCardHeight} />
      </View>
      {items.length > 1 && (
        <Text style={[type.footnote, { fontSize: 12, color: theme.tertiary, textAlign: 'center' }]}>
          {t('reviewPosition', { index: 1, count: items.length })}
        </Text>
      )}
    </View>
  );
}
