import React, { useEffect, useRef } from 'react';
import {
  View,
  Pressable,
  Alert,
  StyleSheet,
  Modal,
  Animated,
  Easing,
  useColorScheme,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BRAND, iosColor } from '@/config/colors';
import { safeHaptics } from '@/lib/utils';
import { RecordingBars } from '@/components/features/WaveformVisualizer';
import { Glass } from '@/components/ui/Glass';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { KEYBOARD_RECORDING_WAVEFORM } from '@/lib/recordingWaveformPattern';

type RecordingOverlayProps = {
  visible: boolean;
  amplitude: number;
  waveformData: number[];
  durationSeconds: number;
  onDone: () => void;
  onDiscard: () => void;
};

type Theme = {
  isDark: boolean;
  backdrop: string;
  pillLabel: string;
  timer: string;
  iconColor: string;
  discardBg: string;
  discardBorder: string;
};

const DARK_THEME: Theme = {
  isDark: true,
  backdrop: '#0A0C0F',
  pillLabel: 'rgba(255, 255, 255, 0.85)',
  timer: 'rgba(255, 255, 255, 0.6)',
  iconColor: '#FFFFFF',
  discardBg: 'rgba(255, 255, 255, 0.10)',
  discardBorder: 'rgba(255, 255, 255, 0.18)',
};

const LIGHT_THEME: Theme = {
  isDark: false,
  backdrop: '#EEF0F4',
  pillLabel: 'rgba(0, 0, 0, 0.75)',
  timer: 'rgba(0, 0, 0, 0.55)',
  iconColor: 'rgba(0, 0, 0, 0.7)',
  discardBg: 'rgba(0, 0, 0, 0.06)',
  discardBorder: 'rgba(0, 0, 0, 0.10)',
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function RecordingOverlay(props: RecordingOverlayProps) {
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => props.onDiscard()}
    >
      <SafeAreaProvider>
        <OverlayContent {...props} />
      </SafeAreaProvider>
    </Modal>
  );
}

function OverlayContent({
  amplitude,
  waveformData,
  durationSeconds,
  onDone,
  onDiscard,
}: Omit<RecordingOverlayProps, 'visible'>) {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme();
  const theme = scheme === 'dark' ? DARK_THEME : LIGHT_THEME;

  const handleDonePress = () => {
    safeHaptics('medium');
    onDone();
  };

  const handleDiscardPress = () => {
    safeHaptics('light');
    Alert.alert('Discard recording?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: onDiscard },
    ]);
  };

  return (
    <>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} animated />
      <View style={styles.container}>
        <View style={[styles.backdrop, { backgroundColor: theme.backdrop }]} />

        <View style={[styles.topGroup, { top: insets.top + 12 }]} pointerEvents="none">
          <Glass className="rounded-full">
            <View style={styles.pillInner}>
              <PulsingDot />
              <Text style={[styles.pillLabel, { color: theme.pillLabel }]}>Recording</Text>
            </View>
          </Glass>
          <Text style={[styles.timer, { color: theme.timer }]}>{formatTime(durationSeconds)}</Text>
        </View>

        <View style={styles.waveformWrap} pointerEvents="none">
          <RecordingBars
            isRecording
            amplitude={amplitude}
            waveformData={waveformData}
            color={BRAND}
            height={KEYBOARD_RECORDING_WAVEFORM.height}
            numBars={KEYBOARD_RECORDING_WAVEFORM.barCount}
            barWidth={KEYBOARD_RECORDING_WAVEFORM.barWidth}
            barGap={KEYBOARD_RECORDING_WAVEFORM.barGap}
            edgeToEdge
          />
        </View>

        <Pressable
          onPress={handleDiscardPress}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={[
            styles.discardButton,
            {
              top: insets.top + 12,
              backgroundColor: theme.discardBg,
              borderColor: theme.discardBorder,
            },
          ]}
        >
          <SystemIcon name="xmark" mdName="X" size={16} color={theme.iconColor} />
        </Pressable>

        <Pressable
          onPress={handleDonePress}
          style={[styles.doneButton, { bottom: insets.bottom + 56 }]}
        >
          <SystemIcon name="checkmark" mdName="Check" size={32} color="#FFFFFF" />
        </Pressable>
      </View>
    </>
  );
}

function PulsingDot() {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return <Animated.View style={[styles.dot, { opacity }]} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  discardButton: {
    position: 'absolute',
    left: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topGroup: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: 8,
  },
  pillInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: iosColor('systemRed'),
  },
  pillLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  timer: {
    fontSize: 14,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.4,
  },
  waveformWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '50%',
    transform: [{ translateY: -KEYBOARD_RECORDING_WAVEFORM.height / 2 }],
    alignItems: 'center',
    justifyContent: 'center',
  },
  doneButton: {
    position: 'absolute',
    left: '50%',
    marginLeft: -38,
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0px 8px 24px rgba(0, 122, 255, 0.25)',
  },
});
