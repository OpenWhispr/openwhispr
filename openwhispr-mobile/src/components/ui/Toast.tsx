import React, { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';
import { Text } from '@/components/ui/Text';
import { Image } from 'expo-image';
import { BRAND, iosColor } from '@/config/colors';

export type ToastType = 'success' | 'error' | 'info';

interface ToastProps {
  message: string;
  visible: boolean;
  type?: ToastType;
  topOffset?: number;
  // Changes on every show, so a repeated identical message still re-announces and replays.
  showId?: number;
}

export function Toast({ message, visible, type = 'info', topOffset = 24, showId }: ToastProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-20)).current;

  // The toast ignores touches, so VoiceOver would never reach it on its own.
  useEffect(() => {
    if (visible && message) AccessibilityInfo.announceForAccessibility(message);
  }, [visible, message, showId]);

  useEffect(() => {
    if (visible) {
      opacity.setValue(0);
      translateY.setValue(-20);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: -10, duration: 150, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, showId, opacity, translateY]);

  const icon =
    type === 'success'
      ? 'sf:checkmark.circle.fill'
      : type === 'error'
        ? 'sf:xmark.circle.fill'
        : 'sf:info.circle.fill';

  const iconColor =
    type === 'success' ? iosColor('systemGreen') : type === 'error' ? iosColor('systemRed') : BRAND;

  return (
    <Animated.View
      style={[styles.container, { top: topOffset, opacity, transform: [{ translateY }] }]}
      pointerEvents="none"
    >
      <Image source={icon} style={{ width: 16, height: 16 }} tintColor={iconColor} />
      <Text style={styles.text}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    alignSelf: 'center',
    maxWidth: '92%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    backgroundColor: iosColor('systemBackground'),
    borderRadius: 12,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: iosColor('separator'),
    gap: 8,
    boxShadow: '0px 4px 20px rgba(0, 0, 0, 0.12)',
    zIndex: 999,
  },
  text: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '500',
    color: iosColor('label'),
  },
});
