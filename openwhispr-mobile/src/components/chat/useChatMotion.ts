import { useEffect } from 'react';
import {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

/**
 * A 0→1 value that loops forever (back and forth when `reverse`). Holds at 0
 * under reduced motion so callers only have to map the value to a style.
 */
export function useLoopValue(
  durationMs: number,
  reverse: boolean,
  enabled = true,
): SharedValue<number> {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion || !enabled) {
      progress.value = 0;
      return;
    }
    progress.value = withRepeat(
      withTiming(1, {
        duration: durationMs,
        easing: reverse ? Easing.inOut(Easing.ease) : Easing.linear,
      }),
      -1,
      reverse,
    );
    return () => cancelAnimation(progress);
  }, [durationMs, enabled, progress, reducedMotion, reverse]);

  return progress;
}

/** Opacity that pulses between `minOpacity` and 1, or sits at 1 under reduced motion. */
export function usePulseStyle(
  minOpacity: number,
  durationMs: number,
  enabled = true,
): { opacity: number } {
  const reducedMotion = useReducedMotion();
  const progress = useLoopValue(durationMs, true, enabled);
  return useAnimatedStyle(() => ({
    opacity: reducedMotion ? 1 : 1 - progress.value * (1 - minOpacity),
  }));
}
