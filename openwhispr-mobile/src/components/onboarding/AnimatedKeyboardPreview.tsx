import { useEffect } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

const TRACK_OFF = '#E5E5EA';
const TRACK_ON = '#34C759';

const LOOP_DURATION = 4800;
const TOGGLE_DURATION = 360;

export function AnimatedKeyboardPreview() {
  const keyboardOn = useSharedValue(0);
  const fullAccessOn = useSharedValue(0);

  useEffect(() => {
    keyboardOn.value = toggleLoop(800);
    fullAccessOn.value = toggleLoop(1800);
  }, [keyboardOn, fullAccessOn]);

  return (
    <View className="w-full overflow-hidden rounded-xl bg-secondarySystemGroupedBackground">
      <View className="px-4 pb-2 pt-3">
        <Text className="text-[12px] uppercase tracking-wide text-tertiaryLabel">
          Settings → Keyboards
        </Text>
      </View>
      <KeyboardRow label="OpenWhispr" toggle={keyboardOn} divider />
      <KeyboardRow label="Allow Full Access" toggle={fullAccessOn} />
    </View>
  );
}

function KeyboardRow({
  label,
  toggle,
  divider,
}: {
  label: string;
  toggle: SharedValue<number>;
  divider?: boolean;
}) {
  const trackStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(toggle.value, [0, 1], [TRACK_OFF, TRACK_ON]),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: toggle.value * 20 }],
  }));

  return (
    <View>
      <View className="flex-row items-center justify-between px-4 py-3">
        <Text className="text-[16px] text-label">{label}</Text>
        <Animated.View className="h-[28px] w-[48px] rounded-full p-0.5" style={trackStyle}>
          <Animated.View
            className="h-[24px] w-[24px] rounded-full bg-white shadow"
            style={thumbStyle}
          />
        </Animated.View>
      </View>
      {divider ? <View className="ml-4 h-px bg-separator" /> : null}
    </View>
  );
}

function toggleLoop(initialDelay: number) {
  return withRepeat(
    withSequence(
      withTiming(0, { duration: 0 }),
      withDelay(
        initialDelay,
        withTiming(1, { duration: TOGGLE_DURATION, easing: Easing.out(Easing.cubic) }),
      ),
      withDelay(LOOP_DURATION - TOGGLE_DURATION - initialDelay, withTiming(1, { duration: 0 })),
    ),
    -1,
    false,
  );
}
