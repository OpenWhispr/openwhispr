import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, AppState, Easing, Image, Pressable, ScrollView, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import type { Transcript } from '@/types';
import { useHomeT, type HomeKey } from './strings';
import { home, SectionHeader, type } from './kit';
import { relativeDate, wordSafeLines, type HomeStats } from './model';

const TIPS: { video: number; poster: number; title: HomeKey; body: HomeKey }[] = [
  {
    video: require('./assets/tip-1-start-dictating.mp4'),
    poster: require('./assets/tip-1-start-dictating-poster.webp'),
    title: 'tip1Title',
    body: 'tip1Body',
  },
  {
    video: require('./assets/tip-2-bubble-size.mp4'),
    poster: require('./assets/tip-2-bubble-size-poster.webp'),
    title: 'tip2Title',
    body: 'tip2Body',
  },
  {
    video: require('./assets/tip-3-hide-bubble.mp4'),
    poster: require('./assets/tip-3-hide-bubble-poster.webp'),
    title: 'tip3Title',
    body: 'tip3Body',
  },
];
const TIP_WIDTH = 228;
// Room around the row so no tip's shadow is cut off by the scroll view.
const SHADOW_ROOM = 24;

function useForeground() {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setActive(state === 'active'),
    );
    return () => subscription.remove();
  }, []);
  return active;
}

function TipCard({ tip, playing }: { tip: (typeof TIPS)[number]; playing: boolean }) {
  const t = useHomeT();
  const [ready, setReady] = useState(false);
  const player = useVideoPlayer(tip.video, (video) => {
    video.loop = true;
    video.muted = true;
    // Never take audio focus from whatever the person is listening to.
    video.audioMixingMode = 'mixWithOthers';
  });
  useEffect(() => {
    try {
      if (playing) player.play();
      else player.pause();
    } catch {
      // expo-video may release the native player before this effect runs.
    }
  }, [player, playing]);
  return (
    <View
      accessible
      accessibilityLabel={`${t(tip.title)}. ${t(tip.body)}`}
      style={{
        width: TIP_WIDTH,
        borderRadius: 20,
        backgroundColor: home.surface,
        boxShadow: home.tipShadow,
      }}
    >
      <View style={{ borderRadius: 20, overflow: 'hidden' }}>
        <View style={{ width: TIP_WIDTH, height: TIP_WIDTH }}>
          <VideoView
            player={player}
            nativeControls={false}
            contentFit="cover"
            surfaceType="textureView"
            allowsPictureInPicture={false}
            onFirstFrameRender={() => setReady(true)}
            style={{ width: TIP_WIDTH, height: TIP_WIDTH }}
          />
          {!ready && (
            <Image
              source={tip.poster}
              style={{ position: 'absolute', width: TIP_WIDTH, height: TIP_WIDTH }}
            />
          )}
        </View>
        <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 14, gap: 2 }}>
          <Text style={type.headline}>{t(tip.title)}</Text>
          <Text style={type.footnote}>{t(tip.body)}</Text>
        </View>
      </View>
    </View>
  );
}

export function Tips({ gutter }: { gutter: number }) {
  const t = useHomeT();
  const focused = useIsFocused();
  const foreground = useForeground();
  return (
    <View>
      <SectionHeader title={t('tips')} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{
          marginHorizontal: -gutter,
          marginTop: 8 - SHADOW_ROOM,
          marginBottom: -SHADOW_ROOM,
        }}
        contentContainerStyle={{
          paddingHorizontal: gutter,
          paddingVertical: SHADOW_ROOM,
          gap: 12,
          alignItems: 'flex-start',
        }}
      >
        {TIPS.map((tip) => (
          <TipCard key={tip.title} tip={tip} playing={focused && foreground} />
        ))}
      </ScrollView>
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View
      accessible
      accessibilityLabel={`${value} ${label}`}
      style={{
        flex: 1,
        backgroundColor: home.surface,
        borderRadius: 16,
        padding: 14,
        gap: 2,
        boxShadow: home.cardShadow,
      }}
    >
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{
          fontSize: 22,
          lineHeight: 28,
          fontWeight: '700',
          letterSpacing: -0.11,
          color: home.text,
        }}
      >
        {value}
      </Text>
      <Text
        numberOfLines={wordSafeLines(label)}
        adjustsFontSizeToFit={wordSafeLines(label) !== undefined}
        minimumFontScale={0.7}
        style={type.footnote}
      >
        {label}
      </Text>
    </View>
  );
}

export function Stats({ stats, feedback }: { stats: HomeStats; feedback?: ReactNode }) {
  const t = useHomeT();
  const dash = '—';
  const days = stats.streakDays;
  return (
    <View style={{ gap: 8 }}>
      <SectionHeader title={t('yourStats')} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Stat
          value={stats.words === undefined ? dash : stats.words.toLocaleString()}
          label={t('wordsSpoken')}
        />
        <Stat
          value={stats.wordsPerMinute == null ? dash : String(stats.wordsPerMinute)}
          label={t('wordsPerMinute')}
        />
        <Stat
          value={days === undefined ? dash : days === 1 ? t('oneDay') : t('days', { count: days })}
          label={t('currentStreak')}
        />
      </View>
      {feedback}
    </View>
  );
}

/**
 * A row just added by an upload waits faded and tinted while Home scrolls to it, then slides
 * in and its light accent tint fades to white.
 */
function useArrival(active: boolean, arriving: boolean) {
  const value = useRef(new Animated.Value(active ? 0 : 1)).current;
  useEffect(() => {
    if (!active) return;
    value.setValue(0);
    if (!arriving) return;
    const animation = Animated.timing(value, {
      toValue: 1,
      duration: 1300,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [active, arriving, value]);
  return {
    backgroundColor: value.interpolate({
      inputRange: [0, 0.15, 1],
      outputRange: ['rgba(21,85,212,0.12)', 'rgba(21,85,212,0.12)', 'rgba(21,85,212,0)'],
    }),
    opacity: value.interpolate({
      inputRange: [0, 0.22],
      outputRange: [0.25, 1],
      extrapolate: 'clamp',
    }),
    transform: [
      {
        translateY: value.interpolate({
          inputRange: [0, 0.22],
          outputRange: [-10, 0],
          extrapolate: 'clamp',
        }),
      },
    ],
  };
}

function HistoryRow({
  item,
  last,
  highlighted,
  arriving,
  busy,
  onCopy,
  onRetry,
}: {
  item: Transcript;
  last: boolean;
  highlighted: boolean;
  arriving: boolean;
  busy: boolean;
  onCopy: (text: string) => void;
  onRetry: (id: string) => void;
}) {
  const t = useHomeT();
  const failed = item.status === 'failed';
  const text = failed ? item.errorMessage || '' : item.text;
  const when = relativeDate(item.createdAt, t);
  const canRetry = failed && Boolean(item.audioUrl) && !busy;
  const arrival = useArrival(highlighted, arriving);
  return (
    <View>
      <Animated.View
        style={[
          {
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 16,
            paddingVertical: 14,
          },
          // The newest row is the card's first: keep the tint inside its rounded top.
          highlighted ? [arrival, { borderTopLeftRadius: 13, borderTopRightRadius: 13 }] : null,
        ]}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={1} style={type.headline}>
            {text}
          </Text>
          {item.cleanupWarning ? (
            <Text accessibilityRole="alert" numberOfLines={2} style={type.footnote}>
              {item.cleanupWarning}
            </Text>
          ) : null}
          <Text numberOfLines={1} style={type.footnote}>
            {failed ? `${when} · ${t('notSent')}` : when}
          </Text>
        </View>
        {failed ? (
          <IconButton
            icon="RotateCcw"
            label={t('retry')}
            disabled={!canRetry}
            onPress={() => onRetry(item.id)}
          />
        ) : (
          <IconButton icon="Copy" label={t('copy')} onPress={() => onCopy(item.text)} />
        )}
      </Animated.View>
      {!last && (
        <View style={{ paddingLeft: 16 }}>
          <View style={{ height: 1, backgroundColor: home.divider }} />
        </View>
      )}
    </View>
  );
}

function IconButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: 'Copy' | 'RotateCcw';
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        marginRight: -6,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      <SystemIcon name="doc.on.doc" mdName={icon} size={20} color={home.secondary} />
    </Pressable>
  );
}

export function HistoryCard({
  items,
  highlightId,
  highlightArriving = false,
  busy,
  onCopy,
  onRetry,
}: {
  items: Transcript[];
  highlightId?: string | null;
  highlightArriving?: boolean;
  busy: boolean;
  onCopy: (text: string) => void;
  onRetry: (id: string) => void;
}) {
  return (
    <View
      style={{
        backgroundColor: home.surface,
        borderWidth: 1,
        borderColor: home.borderDefault,
        borderRadius: 14,
        boxShadow: home.cardShadow,
      }}
    >
      {items.map((item, index) => (
        <HistoryRow
          key={item.id}
          item={item}
          last={index === items.length - 1}
          highlighted={item.id === highlightId}
          arriving={item.id === highlightId && highlightArriving}
          busy={busy}
          onCopy={onCopy}
          onRetry={onRetry}
        />
      ))}
    </View>
  );
}
