import { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { home } from '../home/kit';
import { theme } from '../theme';
import {
  Group,
  ListRow,
  SettingsPage,
  SettingsSlider,
  cardStyle,
  settings,
  showToast,
  useReduceMotion,
} from './kit';
import { useSettingsT } from './strings';
import { bodyText, look } from './look';
import {
  BUBBLE_SIZE,
  DEFAULT_LOOK,
  DEFAULT_SIZE,
  applyBubbleLook,
  saveBubbleSize,
  sizeLabel,
  useBubbleLook,
} from './bubbleAppearance';

const BUBBLE_ICON = require('../home/assets/glossy-icon.png');

/** How long the preview sits still before it shrinks, as the real bubble does when idle. */
const PREVIEW_IDLE_MS = 1500;

/**
 * The real bubble at the size and see-through level being set. With "Shrink when not in use" on,
 * it shrinks to its idle form (the dot or a smaller bubble) once nothing has been touched for a
 * moment, and grows back at the next touch.
 */
function Preview({
  size,
  opacity,
  shrunk,
  dot,
}: {
  size: number;
  opacity: number;
  shrunk: boolean;
  dot: boolean;
}) {
  const t = useSettingsT();
  const reduceMotion = useReduceMotion();
  const shrink = useRef(new Animated.Value(0)).current;
  // The same sizes as the bubble itself: 56 dp at Medium, 34 dp shrunk, a 16 dp dot.
  const full = (size / 64) * 56;
  const small = dot ? 16 : (size / 64) * 34;
  useEffect(() => {
    if (reduceMotion) {
      shrink.setValue(shrunk ? 1 : 0);
      return;
    }
    Animated.spring(shrink, {
      toValue: shrunk ? 1 : 0,
      useNativeDriver: true,
      speed: 14,
      bounciness: shrunk ? 0 : 6,
    }).start();
  }, [shrunk, reduceMotion, shrink]);
  const scale = shrink.interpolate({ inputRange: [0, 1], outputRange: [1, small / full] });
  return (
    <View
      accessible
      accessibilityLabel={t('bubblePreview')}
      style={[
        cardStyle,
        {
          height: 180,
          borderRadius: 20,
          borderWidth: 0,
          boxShadow: undefined,
          backgroundColor: look.selFill,
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      <Animated.View style={{ width: full, height: full, opacity, transform: [{ scale }] }}>
        <Animated.Image
          source={BUBBLE_ICON}
          style={{
            width: full,
            height: full,
            borderRadius: full / 2,
            // Always driven by the same animated value, so the native driver never meets a plain one.
            opacity: shrink.interpolate({ inputRange: [0, 1], outputRange: [1, dot ? 0 : 1] }),
          }}
          accessible={false}
        />
        {dot && (
          <Animated.View
            style={{
              position: 'absolute',
              width: full,
              height: full,
              borderRadius: full / 2,
              backgroundColor: theme.accent,
              opacity: shrink,
            }}
          />
        )}
      </Animated.View>
    </View>
  );
}

function SliderCard({
  title,
  value,
  ends,
  children,
}: {
  title: string;
  value: string;
  ends: [string, string];
  children: React.ReactNode;
}) {
  return (
    <View style={[cardStyle, { paddingHorizontal: 16, paddingVertical: 14, gap: 12 }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={bodyText}>{title}</Text>
        <Text style={[bodyText, settings.tabular, { color: home.accent }]}>{value}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Text style={[settings.subtitle, settings.tabular]}>{ends[0]}</Text>
        {children}
        <Text style={[settings.subtitle, settings.tabular]}>{ends[1]}</Text>
      </View>
    </View>
  );
}

/** Settings → Size & look. Every change reaches the live bubble at once; nothing to save. */
export default function SizeLookScreen() {
  const t = useSettingsT();
  const savedSize = useConfigStore((s) => s.config?.androidBubbleSize ?? DEFAULT_SIZE);
  const look = useBubbleLook();
  const [size, setSize] = useState(savedSize);
  const [opacity, setOpacity] = useState(look.opacity);
  // The preview shrinks like the bubble: after a pause with no finger on a slider.
  const [touches, setTouches] = useState(0);
  const [sliding, setSliding] = useState(false);
  const [resting, setResting] = useState(false);
  const wake = () => setTouches((count) => count + 1);
  useEffect(() => {
    setResting(false);
    if (!look.shrinkWhenIdle || sliding) return;
    const timer = setTimeout(() => setResting(true), PREVIEW_IDLE_MS);
    return () => clearTimeout(timer);
  }, [look.shrinkWhenIdle, look.shrinkToDot, sliding, touches]);

  const reset = () => {
    setSize(DEFAULT_SIZE);
    setOpacity(DEFAULT_LOOK.opacity);
    wake();
    saveBubbleSize(DEFAULT_SIZE);
    applyBubbleLook({ ...DEFAULT_LOOK, size: DEFAULT_SIZE });
    showToast(t('bubbleReset'), 'neutral');
  };

  return (
    <SettingsPage title={t('sizeLook')} right={{ label: t('reset'), onPress: reset }}>
      <Preview size={size} opacity={opacity} shrunk={resting} dot={look.shrinkToDot} />
      <SliderCard title={t('size')} value={t(sizeLabel(size))} ends={[t('small'), t('large')]}>
        <SettingsSlider
          label={t('size')}
          value={size}
          min={BUBBLE_SIZE.min}
          max={BUBBLE_SIZE.max}
          step={1}
          onChange={setSize}
          onActiveChange={setSliding}
          // The live bubble and the saved size change once, when the finger lifts.
          onRelease={(value) => {
            applyBubbleLook({ size: value });
            saveBubbleSize(value);
          }}
        />
      </SliderCard>
      <SliderCard
        title={t('seeThrough')}
        value={`${Math.round(opacity * 100)}%`}
        ends={['20%', '100%']}
      >
        <SettingsSlider
          label={t('seeThrough')}
          value={Math.round(opacity * 100)}
          min={20}
          max={100}
          step={5}
          onChange={(value) => setOpacity(value / 100)}
          onActiveChange={setSliding}
          onRelease={(value) => applyBubbleLook({ opacity: value / 100, size })}
        />
      </SliderCard>
      <Group title={t('whenItShrinks')} inset={14}>
        <ListRow
          title={t('shrinkIdle')}
          subtitle={t('shrinkIdleBody')}
          toggle={{
            value: look.shrinkWhenIdle,
            onValueChange: (shrinkWhenIdle) => applyBubbleLook({ shrinkWhenIdle, size }),
          }}
        />
        <ListRow
          title={t('shrinkDot')}
          subtitle={t('shrinkDotBody')}
          toggle={{
            value: look.shrinkToDot,
            onValueChange: (shrinkToDot) => applyBubbleLook({ shrinkToDot, size }),
            disabled: !look.shrinkWhenIdle,
          }}
        />
        <ListRow
          title={t('shrinkSearch')}
          subtitle={t('shrinkSearchBody')}
          toggle={{
            value: look.shrinkInSearch,
            onValueChange: (shrinkInSearch) => applyBubbleLook({ shrinkInSearch, size }),
            disabled: !look.shrinkWhenIdle,
          }}
        />
      </Group>
    </SettingsPage>
  );
}
