import React, { useState } from 'react';
import { View, StyleSheet, Pressable, Dimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
  Easing,
} from 'react-native-reanimated';
import { Trash2, FolderInput } from 'lucide-react-native';
import { iosColor } from '@/config/colors';

interface SwipeableCardProps {
  children: React.ReactNode;
  onDelete: () => void;
  /** Optional secondary action shown to the left of Delete on swipe. */
  onMove?: () => void;
  /**
   * When true, renders without its own background or vertical margin — for
   * use as a row inside an already-styled container (e.g. GroupedList).
   */
  inset?: boolean;
  /** Override the card's opaque background (must be opaque so swipe actions stay hidden). */
  cardBackground?: string;
}

const ACTION_WIDTH = 56;
const SCREEN_WIDTH = Dimensions.get('window').width;

export function SwipeableCard({
  children,
  onDelete,
  onMove,
  inset = false,
  cardBackground,
}: SwipeableCardProps) {
  const revealWidth = onMove ? ACTION_WIDTH * 2 : ACTION_WIDTH;
  const snapThreshold = -revealWidth * 0.5;

  const translateX = useSharedValue(0);
  const [isRevealed, setIsRevealed] = useState(false);
  const deleteScale = useSharedValue(1);
  const moveScale = useSharedValue(1);

  const updateRevealedState = (revealed: boolean) => {
    setIsRevealed(revealed);
  };

  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onUpdate((event) => {
      if (event.translationX < 0) {
        if (event.translationX < -revealWidth) {
          const resistance = 0.3;
          const excess = event.translationX + revealWidth;
          translateX.value = -revealWidth + excess * resistance;
        } else {
          translateX.value = event.translationX;
        }
      } else if (isRevealed) {
        translateX.value = Math.max(-revealWidth, event.translationX - revealWidth);
      }
    })
    .onEnd(() => {
      if (translateX.value < snapThreshold) {
        translateX.value = withTiming(-revealWidth, {
          duration: 200,
          easing: Easing.out(Easing.cubic),
        });
        runOnJS(updateRevealedState)(true);
      } else {
        translateX.value = withTiming(0, {
          duration: 200,
          easing: Easing.out(Easing.cubic),
        });
        runOnJS(updateRevealedState)(false);
      }
    });

  const handleDeletePress = () => {
    translateX.value = withTiming(
      -SCREEN_WIDTH,
      { duration: 250, easing: Easing.in(Easing.cubic) },
      () => {
        runOnJS(onDelete)();
      },
    );
  };

  const handleMovePress = () => {
    if (!onMove) return;
    translateX.value = withTiming(0, {
      duration: 200,
      easing: Easing.out(Easing.cubic),
    });
    runOnJS(updateRevealedState)(false);
    runOnJS(onMove)();
  };

  const pressIn = (scale: typeof deleteScale) => () => {
    scale.value = withTiming(0.92, { duration: 100, easing: Easing.out(Easing.quad) });
  };

  const pressOut = (scale: typeof deleteScale) => () => {
    scale.value = withTiming(1, { duration: 150, easing: Easing.out(Easing.quad) });
  };

  const animatedStyle = useAnimatedStyle(() => {
    'worklet';
    return { transform: [{ translateX: translateX.value }] };
  });

  const revealStyle = useAnimatedStyle(() => {
    'worklet';
    const opacity = interpolate(
      translateX.value,
      [0, -10, -revealWidth],
      [0, 1, 1],
      Extrapolation.CLAMP,
    );
    return { opacity };
  });

  const deleteScaleStyle = useAnimatedStyle(() => {
    'worklet';
    return { transform: [{ scale: deleteScale.value }] };
  });

  const moveScaleStyle = useAnimatedStyle(() => {
    'worklet';
    return { transform: [{ scale: moveScale.value }] };
  });

  return (
    <View style={[styles.container, inset && styles.containerInset]}>
      {/* Action icons revealed under the row */}
      <Animated.View style={[styles.actionsContainer, { width: revealWidth }, revealStyle]}>
        {onMove && (
          <Pressable
            onPress={handleMovePress}
            onPressIn={pressIn(moveScale)}
            onPressOut={pressOut(moveScale)}
            style={styles.action}
            hitSlop={8}
          >
            <Animated.View style={moveScaleStyle}>
              <FolderInput size={22} color={iosColor('link')} />
            </Animated.View>
          </Pressable>
        )}
        <Pressable
          onPress={handleDeletePress}
          onPressIn={pressIn(deleteScale)}
          onPressOut={pressOut(deleteScale)}
          style={styles.action}
          hitSlop={8}
        >
          <Animated.View style={deleteScaleStyle}>
            <Trash2 size={22} color={iosColor('systemRed')} />
          </Animated.View>
        </Pressable>
      </Animated.View>

      {/* Swipeable Card */}
      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[
            styles.card,
            {
              backgroundColor:
                cardBackground ??
                (inset
                  ? iosColor('secondarySystemGroupedBackground')
                  : iosColor('systemBackground')),
            },
            animatedStyle,
          ]}
        >
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    marginBottom: 4,
  },
  containerInset: {
    marginBottom: 0,
  },
  card: {},
  actionsContainer: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  action: {
    width: ACTION_WIDTH,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
