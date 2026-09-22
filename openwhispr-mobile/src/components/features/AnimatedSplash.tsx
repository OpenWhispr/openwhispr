import React, { useEffect, useCallback, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSpring,
  runOnJS,
  Easing,
} from 'react-native-reanimated';
import * as SplashScreen from 'expo-splash-screen';
import { LinearGradient } from 'expo-linear-gradient';
import { BRAND_GRADIENT } from '@/config/colors';
import { SpaceGrotesk } from '@/lib/fonts';

const LOGO_SIZE = 120;
const RING_THICKNESS = 6;
const BAR_WIDTH = 12;
const BAR_RADIUS = BAR_WIDTH / 2;
const CENTER_BAR_HEIGHT = 40;
const SIDE_BAR_HEIGHT = 28;
const BAR_GAP = 6;

interface AnimatedSplashProps {
  appReady: boolean;
  onFinish: () => void;
}

export function AnimatedSplash({ appReady, onFinish }: AnimatedSplashProps) {
  const logoScale = useSharedValue(0.85);
  const logoOpacity = useSharedValue(0);
  const centerBarHeight = useSharedValue(0);
  const leftBarHeight = useSharedValue(0);
  const rightBarHeight = useSharedValue(0);
  const textOpacity = useSharedValue(0);
  const textTranslateY = useSharedValue(8);
  const containerOpacity = useSharedValue(1);
  const contentScale = useSharedValue(1);
  const isExitingRef = useRef(false);

  const handleFinish = useCallback(() => {
    onFinish();
  }, [onFinish]);

  useEffect(() => {
    logoOpacity.value = withTiming(1, { duration: 400, easing: Easing.out(Easing.cubic) });
    logoScale.value = withSpring(1, { damping: 18, stiffness: 200 });

    centerBarHeight.value = withDelay(
      250,
      withSpring(CENTER_BAR_HEIGHT, { damping: 12, stiffness: 180 }),
    );
    leftBarHeight.value = withDelay(
      350,
      withSpring(SIDE_BAR_HEIGHT, { damping: 12, stiffness: 180 }),
    );
    rightBarHeight.value = withDelay(
      450,
      withSpring(SIDE_BAR_HEIGHT, { damping: 12, stiffness: 180 }),
    );

    textOpacity.value = withDelay(
      650,
      withTiming(1, { duration: 400, easing: Easing.out(Easing.cubic) }),
    );
    textTranslateY.value = withDelay(
      650,
      withTiming(0, { duration: 400, easing: Easing.out(Easing.cubic) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Exit the instant a real screen can render, fading from whatever state the intro
  // has reached — no fixed minimum, so a fast cold start dismisses almost immediately
  // while a slow one keeps the splash up to cover the gap. Guarded so it fires once.
  useEffect(() => {
    if (!appReady || isExitingRef.current) return;
    isExitingRef.current = true;

    contentScale.value = withTiming(1.04, { duration: 350, easing: Easing.in(Easing.cubic) });
    containerOpacity.value = withTiming(
      0,
      { duration: 350, easing: Easing.in(Easing.cubic) },
      (finished) => {
        if (finished) runOnJS(handleFinish)();
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appReady]);

  const handleLayout = useCallback(() => {
    SplashScreen.setOptions?.({ fade: true, duration: 200 });
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  const containerStyle = useAnimatedStyle(() => ({
    opacity: containerOpacity.value,
  }));

  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ scale: contentScale.value }],
  }));

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));

  const centerBarStyle = useAnimatedStyle(() => ({
    height: centerBarHeight.value,
  }));

  const leftBarStyle = useAnimatedStyle(() => ({
    height: leftBarHeight.value,
  }));

  const rightBarStyle = useAnimatedStyle(() => ({
    height: rightBarHeight.value,
  }));

  const textStyle = useAnimatedStyle(() => ({
    opacity: textOpacity.value,
    transform: [{ translateY: textTranslateY.value }],
  }));

  return (
    <Animated.View style={[styles.container, containerStyle]} onLayout={handleLayout}>
      <LinearGradient
        colors={BRAND_GRADIENT}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Animated.View style={[styles.content, contentStyle]}>
        <Animated.View style={logoStyle}>
          <View style={styles.ring}>
            <View style={styles.barsContainer}>
              <Animated.View style={[styles.bar, leftBarStyle]} />
              <Animated.View style={[styles.bar, centerBarStyle]} />
              <Animated.View style={[styles.bar, rightBarStyle]} />
            </View>
          </View>
        </Animated.View>
        <Animated.Text style={[styles.wordmark, textStyle]}>OpenWhispr</Animated.Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: BRAND_GRADIENT[2],
    zIndex: 999,
  },
  content: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
    borderRadius: LOGO_SIZE / 2,
    borderWidth: RING_THICKNESS,
    borderColor: 'rgba(255, 255, 255, 0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.1)',
  },
  barsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: BAR_GAP,
  },
  bar: {
    width: BAR_WIDTH,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderRadius: BAR_RADIUS,
  },
  wordmark: {
    marginTop: 24,
    fontFamily: SpaceGrotesk.semibold,
    fontSize: 24,
    fontWeight: '600',
    letterSpacing: 1,
    color: 'rgba(255, 255, 255, 0.95)',
  },
});
