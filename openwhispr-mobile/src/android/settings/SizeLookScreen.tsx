import { useEffect, useRef, useState } from 'react';
import { Animated, Image, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { home } from '../home/kit';
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

/** The real bubble, at the size and see-through level being set, or the dot it shrinks to. */
function Preview({ size, opacity, dot }: { size: number; opacity: number; dot: boolean }) {
  const t = useSettingsT();
  const reduceMotion = useReduceMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const shownSize = dot ? 16 : (size / 64) * 56;
  useEffect(() => {
    if (reduceMotion) return;
    scale.setValue(0.92);
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 6 }).start();
  }, [dot, reduceMotion, scale]);
  return (
    <View
      accessible
      accessibilityLabel={t('bubblePreview')}
      style={[
        cardStyle,
        {
          height: 180,
          borderWidth: 0,
          boxShadow: undefined,
          backgroundColor: 'rgba(21,85,212,0.12)',
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      <Animated.View style={{ opacity, transform: [{ scale }] }}>
        {dot ? (
          <View
            style={{
              width: shownSize,
              height: shownSize,
              borderRadius: 8,
              backgroundColor: '#2457C5',
            }}
          />
        ) : (
          <Image
            source={BUBBLE_ICON}
            style={{ width: shownSize, height: shownSize, borderRadius: shownSize / 2 }}
            accessible={false}
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
        <Text style={settings.title}>{title}</Text>
        <Text style={[settings.title, settings.tabular, { color: home.accent, fontWeight: '400' }]}>
          {value}
        </Text>
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
  // The dot preview shows while "Shrink to a dot" was the last thing touched.
  const [previewDot, setPreviewDot] = useState(false);

  const reset = () => {
    setSize(DEFAULT_SIZE);
    setOpacity(DEFAULT_LOOK.opacity);
    setPreviewDot(false);
    saveBubbleSize(DEFAULT_SIZE);
    applyBubbleLook({ ...DEFAULT_LOOK, size: DEFAULT_SIZE });
    showToast(t('bubbleReset'), 'neutral');
  };

  return (
    <SettingsPage title={t('sizeLook')} right={{ label: t('reset'), onPress: reset }}>
      <Preview size={size} opacity={opacity} dot={previewDot} />
      <SliderCard title={t('size')} value={t(sizeLabel(size))} ends={[t('small'), t('large')]}>
        <SettingsSlider
          label={t('size')}
          value={size}
          min={BUBBLE_SIZE.min}
          max={BUBBLE_SIZE.max}
          step={1}
          onChange={(value) => {
            setPreviewDot(false);
            setSize(value);
          }}
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
          onChange={(value) => {
            setPreviewDot(false);
            setOpacity(value / 100);
          }}
          onRelease={(value) => applyBubbleLook({ opacity: value / 100, size })}
        />
      </SliderCard>
      <Group title={t('whenItShrinks')} inset={16}>
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
            onValueChange: (shrinkToDot) => {
              setPreviewDot(shrinkToDot);
              applyBubbleLook({ shrinkToDot, size });
            },
          }}
        />
        <ListRow
          title={t('shrinkSearch')}
          subtitle={t('shrinkSearchBody')}
          toggle={{
            value: look.shrinkInSearch,
            onValueChange: (shrinkInSearch) => applyBubbleLook({ shrinkInSearch, size }),
          }}
        />
      </Group>
    </SettingsPage>
  );
}
