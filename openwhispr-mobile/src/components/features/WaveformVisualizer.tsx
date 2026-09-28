import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet, Easing } from 'react-native';
import { BRAND } from '@/config/colors';
import {
  keyboardRecordingBarVisuals,
  meterLevelsForKeyboardBars,
} from '@/lib/recordingWaveformPattern';

interface WaveformVisualizerProps {
  isRecording: boolean;
  isProcessing?: boolean;
  height?: number;
  color?: string;
  backgroundColor?: string;
  amplitude?: number;
  waveformData?: number[];
}

export function WaveformVisualizer({
  isRecording,
  isProcessing = false,
  height = 80,
  color = BRAND,
  backgroundColor = 'transparent',
  amplitude = 0,
  waveformData = [],
}: WaveformVisualizerProps) {
  return (
    <View style={[styles.container, { height, backgroundColor }]}>
      {isProcessing ? (
        <ProcessingWaveform color={color} size={height * 0.8} />
      ) : (
        <RecordingBars
          isRecording={isRecording}
          color={color}
          height={height * 0.7}
          amplitude={amplitude}
          waveformData={waveformData}
        />
      )}
    </View>
  );
}

export function RecordingBars({
  isRecording,
  color = BRAND,
  height = 50,
  amplitude = 0,
  waveformData = [],
  numBars: numBarsOverride,
  barWidth: barWidthOverride,
  barGap: barGapOverride,
  edgeToEdge = false,
}: {
  isRecording: boolean;
  color?: string;
  height?: number;
  amplitude?: number;
  waveformData?: number[];
  numBars?: number;
  barWidth?: number;
  barGap?: number;
  edgeToEdge?: boolean;
}) {
  const numBars = numBarsOverride ?? (height > 80 ? 24 : 18);
  const bars = Array.from({ length: numBars }, (_, i) => i);
  const barWidth = barWidthOverride ?? (height > 80 ? 3 : 2);
  const barGap = barGapOverride ?? 2;

  let barLevels: number[];
  if (!isRecording) {
    barLevels = Array(numBars).fill(0);
  } else if (edgeToEdge) {
    const history = waveformData.length > 0 ? waveformData : [Math.max(0, Math.min(1, amplitude))];
    barLevels = meterLevelsForKeyboardBars(history, numBars);
  } else {
    const normalized = mapWaveformToBars(waveformData, numBars);
    barLevels = normalized.some((value) => value > 0)
      ? normalized
      : Array(numBars).fill(Math.max(0, Math.min(1, amplitude)));
  }

  return (
    <View
      style={[
        styles.barsContainer,
        { height, gap: barGap },
        edgeToEdge && styles.barsContainerEdgeToEdge,
      ]}
    >
      {bars.map((index) => {
        const level = barLevels[index] ?? 0;
        if (edgeToEdge) {
          const visuals = keyboardRecordingBarVisuals(level);
          return (
            <View
              key={index}
              style={{
                width: barWidth,
                height,
                backgroundColor: color,
                borderRadius: barWidth / 2,
                opacity: visuals.opacity,
                transform: [{ scaleY: visuals.scale }],
              }}
            />
          );
        }
        return (
          <AnimatedBar
            key={index}
            isRecording={isRecording}
            level={level}
            color={color}
            height={height}
            width={barWidth}
          />
        );
      })}
    </View>
  );
}

function AnimatedBar({
  isRecording,
  level,
  color,
  height,
  width,
}: {
  isRecording: boolean;
  level: number;
  color: string;
  height: number;
  width: number;
}) {
  const scaleY = useRef(new Animated.Value(0.02)).current;
  const opacity = useRef(new Animated.Value(0.2)).current;

  useEffect(() => {
    if (!isRecording) {
      Animated.parallel([
        Animated.timing(scaleY, {
          toValue: 0.02,
          duration: 140,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.2,
          duration: 140,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      ]).start();
      return;
    }

    const clamped = Math.max(0, Math.min(1, level));
    const shaped = Math.pow(clamped, 0.48);
    const targetScale = 0.02 + shaped * 0.98;
    const targetOpacity = 0.2 + shaped * 0.8;

    Animated.parallel([
      Animated.timing(scaleY, {
        toValue: targetScale,
        duration: 55,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: targetOpacity,
        duration: 55,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    ]).start();
  }, [isRecording, level, scaleY, opacity]);

  return (
    <Animated.View
      style={[
        styles.bar,
        {
          backgroundColor: color,
          height,
          width,
          opacity,
          transform: [{ scaleY }],
        },
      ]}
    />
  );
}

function mapWaveformToBars(waveformData: number[], barCount: number): number[] {
  if (barCount <= 0) return [];
  if (waveformData.length === 0) return Array(barCount).fill(0);

  const recent = waveformData.slice(-barCount);
  if (recent.length <= barCount) {
    return [...Array(barCount - recent.length).fill(0), ...recent];
  }

  const bars: number[] = [];
  for (let i = 0; i < barCount; i += 1) {
    const start = Math.floor((i * recent.length) / barCount);
    const end = Math.max(start + 1, Math.floor(((i + 1) * recent.length) / barCount));
    const window = recent.slice(start, end);
    const average = window.reduce((sum, value) => sum + value, 0) / window.length;
    const peak = window.reduce((max, value) => Math.max(max, value), 0);
    bars.push(Math.min(1, peak * 0.88 + average * 0.12));
  }

  return bars;
}

export function ProcessingWaveform({
  color = '#ffffff',
  size = 32,
}: {
  color?: string;
  size?: number;
}) {
  const barWidth = Math.max(3, size * 0.12);
  const gap = Math.max(3, size * 0.1);

  return (
    <View style={[styles.processingContainer, { height: size, gap }]}>
      {[0, 1, 2].map((i) => (
        <ProcessingBar key={i} index={i} color={color} height={size} width={barWidth} />
      ))}
    </View>
  );
}

function ProcessingBar({
  index,
  color,
  height,
  width,
}: {
  index: number;
  color: string;
  height: number;
  width: number;
}) {
  const scaleY = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(scaleY, {
          toValue: 1,
          duration: 400,
          delay: index * 150,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(scaleY, {
          toValue: 0.3,
          duration: 400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    ).start();
  }, [index, scaleY]);

  return (
    <Animated.View
      style={[
        styles.processingBar,
        {
          width,
          height,
          backgroundColor: color,
          transform: [{ scaleY }],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  barsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  barsContainerEdgeToEdge: {
    paddingHorizontal: 0,
  },
  bar: {
    borderRadius: 1,
    shadowOpacity: 0,
  },
  processingContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
  },
  processingBar: {
    borderRadius: 1,
    opacity: 0.9,
  },
});
