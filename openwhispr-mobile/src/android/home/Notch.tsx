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
  | { kind: 'done'; text: string }
  /** Cancelled or failed: slide back at once, still showing what it last said. */
  | { kind: 'closing' };

type ShownState = Exclude<NotchState, { kind: 'closing' }>;

/** Effective full width: 310, or the card width minus 32 on narrow screens. */
export function notchWidth(cardWidth: number): number {
  return Math.max(NARROW_WIDTH, Math.min(MAX_WIDTH, cardWidth - 32));
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const RING_RADIUS = 8;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
/** Progress reaches the ring in steps (the clock ticks every 250 ms); this glides between them. */
const RING_GLIDE_MS = 260;

function Ring({ value }: { value: Animated.Value }) {
  const offset = value.interpolate({
    inputRange: [0, 1],
    outputRange: [RING_LENGTH, 0],
    extrapolate: 'clamp',
  });
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20">
      <Circle cx={10} cy={10} r={RING_RADIUS} stroke={home.fill} strokeWidth={2.5} fill="none" />
      <AnimatedCircle
        cx={10}
        cy={10}
        r={RING_RADIUS}
        stroke={home.accent}
        strokeWidth={2.5}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${RING_LENGTH} ${RING_LENGTH}`}
        strokeDashoffset={offset}
        transform="rotate(-90 10 10)"
      />
    </Svg>
  );
}

function StateIcon({ state, ring }: { state: ShownState; ring: Animated.Value }) {
  if (state.kind === 'done')
    return <SystemIcon name="checkmark" mdName="Check" size={18} color={home.accent} />;
  if (state.progress !== undefined) return <Ring value={ring} />;
  return <ActivityIndicator size="small" color={home.accent} />;
}

/**
 * The processing notch: a white tab that drops out from under the bubble card's bottom edge,
 * widens, then names what is happening. The parent places it right under the card and gives
 * it `space`, which the notch opens while it is out and closes as it slides back, so what
 * comes next moves down and back up with it. When the state turns `done` it shows the tick
 * for about a second, slides back into the card and calls `onFinished`; `closing` (cancelled
 * or failed) slides back at once.
 */
export function Notch({
  state,
  cardWidth,
  top,
  space,
  spaceOpen,
  onFinished,
}: {
  state: NotchState;
  cardWidth: number;
  /** The card's bottom edge within the parent. */
  top: number;
  /** Room the parent leaves below the card. The notch must sit inside it, since Android only
   * delivers touches inside a view's own bounds (the ✕ lives there). */
  space: Animated.Value;
  /** How much room the notch needs below the card once it is fully out. */
  spaceOpen: number;
  onFinished: () => void;
}) {
  const t = useHomeT();
  const fullWidth = notchWidth(cardWidth);
  const width = useRef(new Animated.Value(NARROW_WIDTH)).current;
  const height = useRef(new Animated.Value(NARROW_HEIGHT)).current;
  const drop = useRef(new Animated.Value(-NARROW_HEIGHT)).current;
  const fade = useRef(new Animated.Value(0)).current;
  const content = useRef(new Animated.Value(0)).current;
  const ring = useRef(
    new Animated.Value(state.kind === 'busy' ? (state.progress ?? 0) : 0),
  ).current;
  const [open, setOpen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  // What the notch shows. It trails `state` while the ring finishes its circle, and keeps the
  // last words on screen while a cancelled notch slides back.
  const [shown, setShown] = useState<ShownState>(
    state.kind === 'closing' ? { kind: 'busy', text: '' } : state,
  );
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

  // Appear: drop out of the card edge, widen, then let the text in. The space below opens
  // over the same time.
  useEffect(() => {
    if (reduceMotion === null) return;
    const ease = Easing.out(Easing.cubic);
    if (reduceMotion) {
      width.setValue(fullWidth);
      height.setValue(FULL_HEIGHT);
      drop.setValue(0);
      content.setValue(1);
      space.setValue(spaceOpen);
      setOpen(true);
      Animated.timing(fade, { toValue: 1, duration: 150, useNativeDriver: false }).start();
      return;
    }
    fade.setValue(1);
    const animation = Animated.parallel([
      Animated.timing(space, {
        toValue: spaceOpen,
        duration: 350,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.sequence([
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

  // Follow the state. The ring glides to each new value; when the ring gives way (to writing
  // it up, or straight to done) it first completes its circle.
  const kind = state.kind;
  const text = state.kind === 'closing' ? '' : state.text;
  const detail = state.kind === 'busy' ? state.detail : undefined;
  const progress = state.kind === 'busy' ? state.progress : undefined;
  const cancellable = state.kind === 'busy' && state.onCancel !== undefined;
  const ringShown = shown.kind === 'busy' && shown.progress !== undefined;
  useEffect(() => {
    if (kind === 'closing') return;
    const next = state as ShownState;
    const glide = (toValue: number, duration: number) =>
      Animated.timing(ring, { toValue, duration, easing: Easing.linear, useNativeDriver: false });
    if (progress !== undefined) {
      setShown(next);
      const animation = glide(progress, reduceMotion ? 0 : RING_GLIDE_MS);
      animation.start();
      return () => animation.stop();
    }
    if (ringShown && !reduceMotion) {
      const animation = glide(1, RING_GLIDE_MS);
      animation.start(({ finished: done }) => done && setShown(next));
      return () => animation.stop();
    }
    setShown(next);
    // `state` and its cancel handler are rebuilt on every render; these fields are what it
    // says. Following the handler would restart the glide on every render, so it never ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, text, detail, progress, cancellable, ringShown, reduceMotion, ring]);

  // Leave: after the tick has shown for a moment, or at once when cancelled. The text fades,
  // then the tab narrows and slides back while the space below closes.
  const leaveAfter = kind === 'closing' ? 0 : shown.kind === 'done' ? DONE_HOLD_MS : null;
  useEffect(() => {
    if (leaveAfter === null || reduceMotion === null) return;
    // A done notch waits until it is fully out; a cancelled one leaves from wherever it is.
    if (!open && leaveAfter > 0) return;
    let animation: Animated.CompositeAnimation | undefined;
    const timer = setTimeout(() => {
      const ease = Easing.in(Easing.cubic);
      const slide = (value: Animated.Value, toValue: number) =>
        Animated.timing(value, { toValue, duration: 200, easing: ease, useNativeDriver: false });
      animation = reduceMotion
        ? Animated.timing(fade, { toValue: 0, duration: 150, useNativeDriver: false })
        : Animated.sequence([
            Animated.timing(content, { toValue: 0, duration: 120, useNativeDriver: false }),
            Animated.parallel([
              slide(width, NARROW_WIDTH),
              slide(height, NARROW_HEIGHT),
              slide(drop, -FULL_HEIGHT),
              Animated.timing(space, {
                toValue: 0,
                duration: 200,
                easing: Easing.inOut(Easing.cubic),
                useNativeDriver: false,
              }),
            ]),
          ]);
      animation.start(() => {
        if (reduceMotion) space.setValue(0);
        finished.current();
      });
    }, leaveAfter);
    return () => {
      clearTimeout(timer);
      animation?.stop();
    };
  }, [leaveAfter, open, reduceMotion, content, drop, fade, height, width, space]);

  const bottomRadius = height.interpolate({
    inputRange: [NARROW_HEIGHT, FULL_HEIGHT],
    outputRange: [NARROW_HEIGHT / 2, 20],
  });
  const busy = shown.kind === 'busy' ? shown : undefined;
  // Always the current handler; none once the notch is on its way out.
  const cancel = state.kind === 'busy' ? state.onCancel : undefined;

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
              <StateIcon state={shown} ring={ring} />
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
                {shown.text}
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
                disabled={!cancel}
                onPress={cancel}
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
          <StateIcon state={shown} ring={ring} />
        )}
      </Animated.View>
    </View>
  );
}
