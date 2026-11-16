import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  View,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { useHomeT } from './strings';
import { home } from './kit';

const NARROW_WIDTH = 72;
const NARROW_HEIGHT = 30;
const FULL_HEIGHT = 44;
const MAX_WIDTH = 310;
const SHOULDER = 12;
const DONE_HOLD_MS = 1000;
/** How far the notch reaches below the bubble card; the space under the card must cover it. */
export const NOTCH_REACH = FULL_HEIGHT;

export type NotchState =
  | {
      kind: 'busy';
      text: string;
      /** Secondary text after the state, such as the file name. Shortened with … when long. */
      detail?: string;
      /** 0..1 fills a progress ring; undefined shows a spinner. */
      progress?: number;
      onCancel?: () => void;
    }
  | { kind: 'done'; text: string };

/** Effective full width: 310, or the card width minus 32 on narrow screens. */
export function notchWidth(cardWidth: number): number {
  return Math.max(NARROW_WIDTH, Math.min(MAX_WIDTH, cardWidth - 32));
}

function Ring({ progress }: { progress: number }) {
  const radius = 8;
  const length = 2 * Math.PI * radius;
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20">
      <Circle cx={10} cy={10} r={radius} stroke={home.fill} strokeWidth={2.5} fill="none" />
      <Circle
        cx={10}
        cy={10}
        r={radius}
        stroke={home.accent}
        strokeWidth={2.5}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${length} ${length}`}
        strokeDashoffset={length * (1 - Math.max(0, Math.min(1, progress)))}
        transform="rotate(-90 10 10)"
      />
    </Svg>
  );
}

function StateIcon({ state }: { state: NotchState }) {
  if (state.kind === 'done')
    return <SystemIcon name="checkmark" mdName="Check" size={18} color={home.accent} />;
  if (state.progress !== undefined) return <Ring progress={state.progress} />;
  return <ActivityIndicator size="small" color={home.accent} />;
}

/**
 * The processing notch: a white tab that drops out from under the bubble card's bottom edge,
 * widens, then names what is happening. It takes no layout space; the parent positions it
 * right under the card and leaves room below. When the state turns `done` it shows the tick
 * for about a second, slides back into the card and calls `onFinished`.
 */
export function Notch({
  state,
  cardWidth,
  top,
  onFinished,
}: {
  state: NotchState;
  cardWidth: number;
  /** The card's bottom edge within the parent. The parent must reach NOTCH_REACH below it,
   * since Android only delivers touches inside a view's own bounds (the ✕ lives there). */
  top: number;
  onFinished: () => void;
}) {
  const t = useHomeT();
  const fullWidth = notchWidth(cardWidth);
  const width = useRef(new Animated.Value(NARROW_WIDTH)).current;
  const height = useRef(new Animated.Value(NARROW_HEIGHT)).current;
  const drop = useRef(new Animated.Value(-NARROW_HEIGHT)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const content = useRef(new Animated.Value(0)).current;
  const [open, setOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    let current = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => current && setReduceMotion(value))
      .catch(() => current && setReduceMotion(false));
    return () => {
      current = false;
    };
  }, []);

  // Appear: drop out of the card edge, widen, then let the text in.
  useEffect(() => {
    if (reduceMotion === null) return;
    const ease = Easing.out(Easing.cubic);
    if (reduceMotion) {
      width.setValue(fullWidth);
      height.setValue(FULL_HEIGHT);
      drop.setValue(0);
      content.setValue(1);
      setOpen(true);
      Animated.timing(fade, { toValue: 1, duration: 150, useNativeDriver: false }).start();
      return;
    }
    fade.setValue(1);
    const animation = Animated.sequence([
      Animated.timing(drop, { toValue: 0, duration: 150, easing: ease, useNativeDriver: false }),
      Animated.parallel([
        Animated.timing(width, {
          toValue: fullWidth,
          duration: 200,
          easing: ease,
          useNativeDriver: false,
        }),
        Animated.timing(height, {
          toValue: FULL_HEIGHT,
          duration: 200,
          easing: ease,
          useNativeDriver: false,
        }),
      ]),
    ]);
    animation.start(({ finished: done }) => {
      if (!done) return;
      setOpen(true);
      Animated.timing(content, { toValue: 1, duration: 120, useNativeDriver: false }).start();
    });
    return () => animation.stop();
    // Runs once, when reduce motion is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  // A card resize (rotation, split screen) keeps the full width in step.
  useEffect(() => {
    if (open) width.setValue(fullWidth);
  }, [fullWidth, open, width]);

  // Done: hold the tick, then fade the text, narrow and slide back into the card.
  const done = state.kind === 'done';
  useEffect(() => {
    if (!done || !open || reduceMotion === null) return;
    let animation: Animated.CompositeAnimation | undefined;
    const timer = setTimeout(() => {
      const ease = Easing.in(Easing.cubic);
      animation = reduceMotion
        ? Animated.timing(fade, { toValue: 0, duration: 150, useNativeDriver: false })
        : Animated.sequence([
            Animated.timing(content, { toValue: 0, duration: 120, useNativeDriver: false }),
            Animated.parallel([
              Animated.timing(width, {
                toValue: NARROW_WIDTH,
                duration: 200,
                easing: ease,
                useNativeDriver: false,
              }),
              Animated.timing(height, {
                toValue: NARROW_HEIGHT,
                duration: 200,
                easing: ease,
                useNativeDriver: false,
              }),
              Animated.timing(drop, {
                toValue: -FULL_HEIGHT,
                duration: 200,
                easing: ease,
                useNativeDriver: false,
              }),
            ]),
          ]);
      animation.start(() => finished.current());
    }, DONE_HOLD_MS);
    return () => {
      clearTimeout(timer);
      animation?.stop();
    };
  }, [done, open, reduceMotion, content, drop, fade, height, width]);

  const bottomRadius = height.interpolate({
    inputRange: [NARROW_HEIGHT, FULL_HEIGHT],
    outputRange: [NARROW_HEIGHT / 2, 20],
  });
  const busy = state.kind === 'busy' ? state : undefined;

  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, top, alignItems: 'center' }}
    >
      <Animated.View
        accessibilityLiveRegion="polite"
        style={{
          width,
          height,
          opacity: fade,
          marginTop: -1,
          transform: [{ translateY: drop }],
          backgroundColor: home.surface,
          borderBottomLeftRadius: bottomRadius,
          borderBottomRightRadius: bottomRadius,
          boxShadow: home.cardShadow,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Concave shoulders where the tab meets the card. */}
        <View
          style={{
            position: 'absolute',
            top: 0,
            left: -SHOULDER,
            width: SHOULDER,
            height: SHOULDER,
            backgroundColor: home.surface,
          }}
        >
          <View style={{ flex: 1, backgroundColor: home.canvas, borderTopRightRadius: SHOULDER }} />
        </View>
        <View
          style={{
            position: 'absolute',
            top: 0,
            right: -SHOULDER,
            width: SHOULDER,
            height: SHOULDER,
            backgroundColor: home.surface,
          }}
        >
          <View style={{ flex: 1, backgroundColor: home.canvas, borderTopLeftRadius: SHOULDER }} />
        </View>
        {open ? (
          <Animated.View
            style={{
              opacity: content,
              flexDirection: 'row',
              alignItems: 'center',
              alignSelf: 'stretch',
              paddingLeft: 14,
              paddingRight: busy?.onCancel ? 2 : 14,
              gap: 8,
            }}
          >
            <View
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: busy?.onCancel ? 'flex-start' : 'center',
                gap: 8,
              }}
            >
              <StateIcon state={state} />
              <Text
                numberOfLines={1}
                style={{
                  // With a file name beside it, the name gives way first so the percent stays.
                  flexShrink: busy?.detail ? 0 : 1,
                  fontSize: 14,
                  lineHeight: 18,
                  fontWeight: '500',
                  color: home.text,
                }}
              >
                {state.text}
              </Text>
              {busy?.detail ? (
                <Text
                  numberOfLines={1}
                  ellipsizeMode="middle"
                  style={{ flexShrink: 1, fontSize: 13, lineHeight: 18, color: home.tertiary }}
                >
                  {busy.detail}
                </Text>
              ) : null}
            </View>
            {busy?.onCancel ? (
              <Pressable
                cssInterop={false}
                accessibilityRole="button"
                accessibilityLabel={t('cancelUpload')}
                onPress={busy.onCancel}
                hitSlop={{ top: 2, bottom: 2, left: 4, right: 4 }}
                style={({ pressed }) => ({
                  width: 40,
                  height: FULL_HEIGHT,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.5 : 1,
                })}
              >
                <SystemIcon name="xmark" mdName="X" size={18} color={home.secondary} />
              </Pressable>
            ) : null}
          </Animated.View>
        ) : (
          <StateIcon state={state} />
        )}
      </Animated.View>
    </View>
  );
}
