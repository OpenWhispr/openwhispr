import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Animated,
  AppState,
  Easing,
  Image,
  Pressable,
  useWindowDimensions,
  View,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import type { Transcript } from '@/types';
import { useHomeT, type HomeKey } from './strings';
import { IconTile, SectionHeader, TileButton, useHome } from './kit';
import { BottomSheet, PillAction } from '../settings/kit';
import { tipsVisible, useTips, type TipId } from './tipsState';
import { relativeDate, wordSafeLines, type HomeStats } from './model';

const TIPS: { id: TipId; video: number; poster: number; title: HomeKey; body: HomeKey }[] = [
  {
    id: 'dictate',
    video: require('./assets/tip-1-dictation.mp4'),
    poster: require('./assets/tip-1-dictation-poster.webp'),
    title: 'tip1Title',
    body: 'tip1Body',
  },
  {
    id: 'assistant',
    video: require('./assets/tip-2-assistant.mp4'),
    poster: require('./assets/tip-2-assistant-poster.webp'),
    title: 'tipAssistantTitle',
    body: 'tipAssistantBody',
  },
  {
    id: 'translate',
    video: require('./assets/tip-3-translate.mp4'),
    poster: require('./assets/tip-3-translate-poster.webp'),
    title: 'tipTranslateTitle',
    body: 'tipTranslateBody',
  },
  {
    id: 'edit',
    video: require('./assets/tip-4-edit.mp4'),
    poster: require('./assets/tip-4-edit-poster.webp'),
    title: 'tipEditTitle',
    body: 'tipEditBody',
  },
  {
    id: 'size',
    video: require('./assets/tip-5-bubble-size.mp4'),
    poster: require('./assets/tip-5-bubble-size-poster.webp'),
    title: 'tip2Title',
    body: 'tip2Body',
  },
  {
    id: 'hide',
    video: require('./assets/tip-6-hide-bubble.mp4'),
    poster: require('./assets/tip-6-hide-bubble-poster.webp'),
    title: 'tip3Title',
    body: 'tip3Body',
  },
];

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

/** Inset hairline between rows of a card (black 6%, inset 14). */
function RowDivider() {
  const { c } = useHome();
  return (
    <View style={{ paddingLeft: 14 }}>
      <View style={{ height: 1, backgroundColor: c.hairline }} />
    </View>
  );
}

/**
 * A tip's poster in a 36 grey tile, with a small play mark: tapping the row plays the video. In
 * dark the light screenshot sits inside a dark frame (design §3.6), so it never glares.
 */
function TipThumbnail({ poster }: { poster: number }) {
  const { c } = useHome();
  const frame = c.posterFrame;
  return (
    <IconTile>
      {frame ? (
        <View style={{ width: 36, height: 36, padding: 3, backgroundColor: frame }}>
          <Image source={poster} style={{ width: 30, height: 30, borderRadius: 7 }} />
        </View>
      ) : (
        <Image source={poster} style={{ width: 36, height: 36 }} />
      )}
      <View
        style={{
          position: 'absolute',
          width: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: 'rgba(0,0,0,0.45)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <SystemIcon name="play.fill" mdName="Play" size={10} color={c.onGlass} />
      </View>
    </IconTile>
  );
}

/** The tip's video, large and looping, in a canvas sheet; "Got it" closes it. */
function TipSheet({
  tip,
  visible,
  onClose,
}: {
  tip: (typeof TIPS)[number];
  visible: boolean;
  onClose: () => void;
}) {
  const t = useHomeT();
  const { c, type, theme } = useHome();
  const foreground = useForeground();
  const { width, height } = useWindowDimensions();
  const size = Math.min(width - 32, 360, height * 0.45);
  const [ready, setReady] = useState(false);
  const player = useVideoPlayer(tip.video, (video) => {
    video.loop = true;
    video.muted = true;
    // Never take audio focus from whatever the person is listening to.
    video.audioMixingMode = 'mixWithOthers';
  });
  useEffect(() => {
    try {
      if (visible && foreground) player.play();
      else player.pause();
    } catch {
      // expo-video may release the native player before this effect runs.
    }
  }, [player, visible, foreground]);
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={t(tip.title)}
      trailing={
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={t('close')}
          onPress={onClose}
          hitSlop={6}
          style={({ pressed }) => [
            theme.raised,
            {
              width: 36,
              height: 36,
              borderRadius: 18,
              alignItems: 'center',
              justifyContent: 'center',
            },
            pressed && theme.raisedPressed,
          ]}
        >
          <SystemIcon name="xmark" mdName="X" size={18} color={c.text} />
        </Pressable>
      }
    >
      <View
        style={[
          {
            alignSelf: 'center',
            width: size,
            height: size,
            borderRadius: 16,
            overflow: 'hidden',
            backgroundColor: c.tile,
          },
          // Dark: the light video sits in a #202128 frame (design §3.6). Always set, so the
          // view's border never goes from unset to a width as the scheme changes.
          { borderWidth: c.posterFrame ? 6 : 0, borderColor: c.posterFrame ?? 'transparent' },
        ]}
      >
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="cover"
          surfaceType="textureView"
          allowsPictureInPicture={false}
          onFirstFrameRender={() => setReady(true)}
          style={{ flex: 1 }}
        />
        {!ready && (
          <Image
            source={tip.poster}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
          />
        )}
      </View>
      <Text style={type.footnote}>{t(tip.body)}</Text>
      <PillAction primary label={t('gotIt')} onPress={onClose} />
    </BottomSheet>
  );
}

/**
 * Tips as one card of rows, each with its video's thumbnail. A row opens the video in a sheet.
 * Watching all three, or "Hide", removes Tips from Home.
 */
export function Tips() {
  const t = useHomeT();
  const { c, type, card } = useHome();
  const tips = useTips();
  const [open, setOpen] = useState<number | null>(null);
  // The sheet keeps its tip while it slides away.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    void tips.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Tips goes only once its sheet has closed, so the last video is never cut short.
  if (!tipsVisible(tips) && open === null) return null;
  const close = () => {
    if (open !== null) tips.watch(TIPS[open].id);
    setOpen(null);
  };
  return (
    <View style={{ gap: 8 }}>
      <SectionHeader title={t('tips')} action={{ label: t('hide'), onPress: tips.hide }} />
      <View style={card}>
        {TIPS.map((tip, index) => (
          <View key={tip.title}>
            <Pressable
              cssInterop={false}
              accessibilityRole="button"
              accessibilityLabel={`${t(tip.title)}. ${t(tip.body)}`}
              onPress={() => {
                setShown(index);
                setOpen(index);
              }}
              style={({ pressed }) => [ROW, pressed && { backgroundColor: c.tile }]}
            >
              <TipThumbnail poster={tip.poster} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.rowTitle}>{t(tip.title)}</Text>
                <Text style={type.footnote}>{t(tip.body)}</Text>
              </View>
              <SystemIcon name="chevron.right" mdName="ChevronRight" size={20} color={c.tertiary} />
            </Pressable>
            {index < TIPS.length - 1 && <RowDivider />}
          </View>
        ))}
      </View>
      <TipSheet key={shown} tip={TIPS[shown]} visible={open !== null} onClose={close} />
    </View>
  );
}

const ROW = {
  flexDirection: 'row' as const,
  alignItems: 'center' as const,
  gap: 12,
  paddingLeft: 14,
  paddingRight: 12,
  paddingVertical: 12,
  minHeight: 60,
};

function StatColumn({ value, label }: { value: string; label: string }) {
  const { c } = useHome();
  return (
    <View
      accessible
      accessibilityLabel={`${value} ${label}`}
      style={{ flex: 1, alignItems: 'center', gap: 2, paddingHorizontal: 6 }}
    >
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={{
          fontSize: 22,
          lineHeight: 28,
          fontWeight: '700',
          letterSpacing: -0.11,
          color: c.text,
          textAlign: 'center',
        }}
      >
        {value}
      </Text>
      <Text
        numberOfLines={wordSafeLines(label)}
        adjustsFontSizeToFit={wordSafeLines(label) !== undefined}
        minimumFontScale={0.7}
        style={{
          fontSize: 12,
          lineHeight: 16,
          letterSpacing: 0.06,
          color: c.secondary,
          textAlign: 'center',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function StatDivider() {
  const { c } = useHome();
  return <View style={{ width: 1, height: 36, backgroundColor: c.hairline }} />;
}

/** One strip: words spoken, words per minute, streak, with thin dividers between. */
export function Stats({ stats, feedback }: { stats: HomeStats; feedback?: ReactNode }) {
  const t = useHomeT();
  const { card } = useHome();
  const dash = '—';
  const days = stats.streakDays;
  return (
    <View style={{ gap: 8 }}>
      <SectionHeader title={t('yourStats')} />
      <View style={[card, { flexDirection: 'row', alignItems: 'center', paddingVertical: 14 }]}>
        <StatColumn
          value={stats.words === undefined ? dash : stats.words.toLocaleString()}
          label={t('wordsSpoken')}
        />
        <StatDivider />
        <StatColumn
          value={stats.wordsPerMinute == null ? dash : String(stats.wordsPerMinute)}
          label={t('wordsPerMin')}
        />
        <StatDivider />
        <StatColumn
          value={days === undefined ? dash : days === 1 ? t('oneDay') : t('days', { count: days })}
          label={t('streak')}
        />
      </View>
      {feedback}
    </View>
  );
}

/**
 * A row just added by an upload looks like any other while Home scrolls to it; once it is in
 * view a soft accent highlight eases in, holds briefly and fades away.
 */
function useArrival(arriving: boolean) {
  const { c } = useHome();
  const tint = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!arriving) return;
    tint.setValue(0);
    const animation = Animated.sequence([
      Animated.timing(tint, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }),
      Animated.delay(350),
      Animated.timing(tint, {
        toValue: 0,
        duration: 750,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: false,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [arriving, tint]);
  return {
    backgroundColor: tint.interpolate({
      inputRange: [0, 1],
      outputRange: [c.arrivalFrom, c.arrivalTo],
    }),
  };
}

/** Where a row's text came from: a dictation (mic) or an uploaded audio file. */
export function HistoryRow({
  item,
  last,
  meta,
  highlighted = false,
  arriving = false,
  busy,
  onCopy,
  onRetry,
}: {
  item: Transcript;
  last: boolean;
  /** When it was said; Home shows how long ago, the History page the time or day. */
  meta?: string;
  highlighted?: boolean;
  arriving?: boolean;
  busy: boolean;
  onCopy: (text: string) => void;
  onRetry: (id: string) => void;
}) {
  const t = useHomeT();
  const { type } = useHome();
  const failed = item.status === 'failed';
  const text = failed ? item.errorMessage || '' : item.text;
  const when = meta ?? relativeDate(item.createdAt, t);
  const canRetry = failed && Boolean(item.audioUrl) && !busy;
  const arrival = useArrival(highlighted && arriving);
  const source = item.requestContext === 'file' ? t('fromFile') : t('fromDictation');
  return (
    <View>
      <Animated.View
        style={[
          // A long dictation grows the row downwards; Copy (or Retry) stays top right.
          { ...ROW, minHeight: 64, alignItems: 'flex-start' },
          // The newest row is the card's first: keep the tint inside its rounded top.
          highlighted ? [arrival, { borderTopLeftRadius: 15, borderTopRightRadius: 15 }] : null,
        ]}
      >
        <View
          accessible
          accessibilityLabel={`${source}. ${text}. ${failed ? `${when}, ${t('notSent')}` : when}`}
          // The first line sits level with the 36 dp button beside it.
          style={{ flex: 1, gap: 2, paddingTop: 7 }}
        >
          {/* The whole dictation, wrapped: never cut off (Josh, 25 Nov). */}
          <Text style={type.rowTitle}>{text}</Text>
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
          <TileButton
            accent
            icon="RotateCcw"
            label={t('retry')}
            disabled={!canRetry}
            onPress={() => onRetry(item.id)}
          />
        ) : (
          <TileButton icon="Copy" label={t('copy')} onPress={() => onCopy(item.text)} />
        )}
      </Animated.View>
      {!last && <RowDivider />}
    </View>
  );
}

/** Home's History: the newest rows, ending in "See all history", which opens the full page. */
export function HistoryCard({
  items,
  highlightId,
  highlightArriving = false,
  busy,
  onCopy,
  onRetry,
  onSeeAll,
}: {
  items: Transcript[];
  highlightId?: string | null;
  highlightArriving?: boolean;
  busy: boolean;
  onCopy: (text: string) => void;
  onRetry: (id: string) => void;
  onSeeAll?: () => void;
}) {
  const t = useHomeT();
  const { c, type, card } = useHome();
  return (
    <View style={card}>
      {items.map((item, index) => (
        <HistoryRow
          key={item.id}
          item={item}
          last={index === items.length - 1 && !onSeeAll}
          highlighted={item.id === highlightId}
          arriving={item.id === highlightId && highlightArriving}
          busy={busy}
          onCopy={onCopy}
          onRetry={onRetry}
        />
      ))}
      {onSeeAll ? (
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          onPress={onSeeAll}
          style={({ pressed }) => [
            { ...ROW, minHeight: 52 },
            pressed && { backgroundColor: c.tile },
          ]}
        >
          <Text style={[type.rowTitle, { flex: 1, color: c.accent }]}>{t('seeAllHistory')}</Text>
          <SystemIcon name="chevron.right" mdName="ChevronRight" size={20} color={c.tertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}
