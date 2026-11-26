import React, { forwardRef, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { AppFont } from '@/android/shared/lib/fonts';
import { useTheme } from './ThemeProvider';

/**
 * The one progress bar: an inset grey track, 6 tall and fully round, that fills with the brand
 * glass. `value` is 0–1; without one it is indeterminate, a glass segment sweeping across.
 */
export function ProgressBar({
  value,
  height = 6,
  accessibilityLabel,
  style,
}: {
  value?: number;
  height?: number;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { inset, glass } = useTheme();
  const share = value === undefined ? undefined : Math.min(1, Math.max(0, value));
  return (
    <View
      accessible={Boolean(accessibilityLabel)}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={
        share === undefined ? undefined : { min: 0, max: 100, now: Math.round(share * 100) }
      }
      style={[
        inset,
        { height, borderRadius: height / 2, overflow: 'hidden', justifyContent: 'center' },
        style,
      ]}
    >
      {share === undefined ? (
        <Sweep height={height} />
      ) : (
        <View
          style={[
            {
              width: `${share * 100}%`,
              height,
              borderRadius: height / 2,
              experimental_backgroundImage: glass.experimental_backgroundImage,
            },
          ]}
        />
      )}
    </View>
  );
}

const SWEEP_SHARE = 0.35;

function Sweep({ height }: { height: number }) {
  const { glass } = useTheme();
  const [width, setWidth] = useState(0);
  const [reduce, setReduce] = useState(false);
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => mounted && setReduce(value))
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);
  useEffect(() => {
    if (!width || reduce) return;
    const loop = Animated.loop(
      Animated.timing(x, {
        toValue: 1,
        duration: 1400,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [width, reduce, x]);
  const segment = width * SWEEP_SHARE;
  return (
    <View
      style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
    >
      {width > 0 && (
        <Animated.View
          style={{
            width: segment,
            height,
            borderRadius: height / 2,
            experimental_backgroundImage: glass.experimental_backgroundImage,
            transform: [
              reduce
                ? { translateX: (width - segment) / 2 }
                : {
                    translateX: x.interpolate({
                      inputRange: [0, 1],
                      outputRange: [-segment, width],
                    }),
                  },
            ],
          }}
        />
      )}
    </View>
  );
}

/**
 * The one search field: a flat field (white in light), corners 12, 48 tall, a magnifier and a tertiary
 * placeholder, and a clear button once something is typed.
 */
export const SearchField = forwardRef<
  TextInput,
  {
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
    /** TalkBack's name for the clear button. */
    clearLabel: string;
    style?: StyleProp<ViewStyle>;
  } & Omit<TextInputProps, 'value' | 'onChangeText' | 'placeholder' | 'style'>
>(function SearchField({ value, onChangeText, placeholder, clearLabel, style, ...input }, ref) {
  const { flat, tokens: theme } = useTheme();
  return (
    <View
      style={[
        flat,
        {
          borderRadius: 12,
          borderColor: theme.fieldHairline,
          minHeight: 48,
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 12,
        },
        style,
      ]}
    >
      <SystemIcon name="magnifyingglass" mdName="Search" size={18} color={theme.tertiary} />
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.tertiary}
        accessibilityLabel={placeholder}
        returnKeyType="search"
        autoCorrect={false}
        {...input}
        style={{
          flex: 1,
          minHeight: 46,
          paddingHorizontal: 10,
          fontSize: 16,
          color: theme.ink,
          fontFamily: AppFont.regular,
        }}
      />
      {value ? (
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={clearLabel}
          onPress={() => {
            onChangeText('');
            if (ref && typeof ref === 'object') ref.current?.focus();
          }}
          hitSlop={4}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <SystemIcon name="xmark.circle.fill" mdName="CircleX" size={18} color={theme.tertiary} />
        </Pressable>
      ) : null}
    </View>
  );
});
