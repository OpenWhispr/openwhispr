import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Dimensions,
  Image,
  Keyboard,
  Pressable,
  StatusBar,
  StyleSheet,
  View,
  type KeyboardEvent,
  type LayoutRectangle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, { FadeIn, FadeOut, ZoomIn } from 'react-native-reanimated';
import { Text } from '@/components/ui/Text';
import { AppFont } from '@/lib/fonts';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { glassEdge } from '../home/kit';
import { AccentText, GLASS_GRADIENT, colors } from './kit';
import { placeCoachTag, type Frame, type TagPlacement } from './coachTag';
import { Glyph, type GlyphName } from './PracticeBubble';
import { useOnboardingT, type OnboardingKey } from './strings';

const ICONS = {
  whatsapp: require('./assets/apps/whatsapp.png'),
  gmail: require('./assets/apps/gmail.png'),
};

/**
 * The text inside every practice card, typed or pasted: one padding for all three practices, with
 * room from the card's edges (Josh, 20 Nov), lined up with the header's icon.
 */
export const fieldText = {
  minHeight: 112,
  paddingHorizontal: 20,
  paddingTop: 18,
  paddingBottom: 20,
  fontSize: 17,
  lineHeight: 25,
  color: colors.ink,
  textAlignVertical: 'top',
} as const;

/** The app the practice pretends to be: a white glass-edge card with the app's header. */
export function AppCard({
  app,
  header,
  children,
}: {
  app: keyof typeof ICONS;
  /** Replaces the header row, as Android's selection toolbar does over the field. */
  header?: ReactNode;
  children: ReactNode;
}) {
  const t = useOnboardingT();
  return (
    <View style={p.card}>
      <View style={p.cardHeader}>
        <Image source={ICONS[app]} style={p.appIcon} />
        <Text style={p.appName}>{t(app === 'gmail' ? 'appGmail' : 'appWhatsApp')}</Text>
        <View style={p.send}>
          <SystemIcon
            name="paperplane.fill"
            mdName="SendHorizontal"
            size={14}
            color={colors.accent}
          />
        </View>
        {header}
      </View>
      {children}
    </View>
  );
}

// Where the keyboard's top edge was last seen, in screen coordinates. The guidance and the
// bubble (or the button) stay pinned there even while the keyboard is closed, as in Wispr Flow.
let rememberedKeyboardTop: number | null = null;
function anchorTop(current: number | null): number {
  if (current !== null) return current;
  if (rememberedKeyboardTop !== null) return rememberedKeyboardTop;
  return Dimensions.get('screen').height * 0.58;
}

/**
 * Keeps the practice's guidance and bubble just above the keyboard line. `onHide` runs when the
 * keyboard closes (the back gesture), which the practices treat as leaving the text box.
 */
export function useKeyboardAnchor(onHide?: () => void) {
  const root = useRef<View>(null);
  const mounted = useRef(true);
  const hideRef = useRef(onHide);
  hideRef.current = onHide;
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);
  const [overlayBottom, setOverlayBottom] = useState(16);

  const place = useCallback((top: number | null) => {
    if (top === null) return;
    root.current?.measureInWindow((_x, y, _w, height) => {
      // The keyboard reports screen coordinates; window coordinates start below the status bar.
      const bottom = y + height + (StatusBar.currentHeight ?? 0);
      if (mounted.current) setOverlayBottom(Math.max(12, bottom - top + 12));
    });
  }, []);

  useEffect(() => {
    mounted.current = true;
    const show = Keyboard.addListener('keyboardDidShow', (event: KeyboardEvent) => {
      rememberedKeyboardTop = event.endCoordinates.screenY;
      setKeyboardTop(event.endCoordinates.screenY);
      place(event.endCoordinates.screenY);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardTop(null);
      hideRef.current?.();
    });
    // The keyboard can stay open from the previous practice, so no show event arrives.
    const open = Keyboard.isVisible() ? Keyboard.metrics() : undefined;
    if (open) {
      rememberedKeyboardTop = open.screenY;
      setKeyboardTop(open.screenY);
      place(open.screenY);
    }
    return () => {
      mounted.current = false;
      show.remove();
      hide.remove();
    };
  }, [place]);

  // Measure again once the screen has laid out: the first measurement can run before layout.
  useEffect(() => {
    const frame = requestAnimationFrame(() => place(anchorTop(keyboardTop)));
    return () => cancelAnimationFrame(frame);
  }, [keyboardTop, place]);

  return {
    root,
    keyboardTop,
    overlayBottom,
    onLayout: () => place(anchorTop(keyboardTop)),
  };
}

/** The line a practice ends on, centred under the card once the keyboard is down. */
export function DoneLine({ text }: { text: string }) {
  return (
    <Animated.View entering={FadeIn.duration(240)} style={{ paddingTop: 36, paddingHorizontal: 8 }}>
      <AccentText center text={text} style={p.done} />
    </Animated.View>
  );
}

/** The right-aligned guidance beside the bubble ("Now hold the bubble"). */
export function Hint({ text }: { text: string }) {
  return <AccentText text={text} style={p.hint} />;
}

/** What to say, quoted, above the bubble while it listens (OB/Say card). */
export function SayCard({ quote }: { quote: OnboardingKey }) {
  const t = useOnboardingT();
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(140)} style={p.say}>
      <Text style={p.sayLabel}>{t('sayLabel').toUpperCase()}</Text>
      <Text style={p.sayQuote}>{t(quote)}</Text>
    </Animated.View>
  );
}

export type MenuRow = 'assistant' | 'translate' | 'edit';

const ROWS: { id: MenuRow; glyph: GlyphName; title: OnboardingKey; body: OnboardingKey }[] = [
  { id: 'assistant', glyph: 'sparkle', title: 'menuAssistant', body: 'menuAssistantBody' },
  { id: 'translate', glyph: 'globe', title: 'menuTranslate', body: 'menuTranslateBody' },
  { id: 'edit', glyph: 'pencil', title: 'menuEdit', body: 'menuEditBody' },
];

// The menu grows for 220 ms; the tag fades in 120 ms after that (rule card 5276:7769).
const MENU_GROW_MS = 220;
const TAG_FADE_MS = 120;

/**
 * V3/Menu as the bubble draws it, with the practice's coach tag on [target]. Only [target] is live.
 * The tag is placed from the menu's measured frame every time anything here lays out again
 * (rotation, font or display size, keyboard height, a translated label widening the menu), so it
 * always sits beside its row. `offsetX` is where this layer starts on screen (its parent's inset).
 */
export function PracticeMenu({
  target,
  language,
  offsetX,
  onPick,
  onClose,
}: {
  target: MenuRow;
  language: string;
  offsetX: number;
  onPick: () => void;
  onClose: () => void;
}) {
  const t = useOnboardingT();
  const [menu, setMenu] = useState<LayoutRectangle | null>(null);
  const [row, setRow] = useState<LayoutRectangle | null>(null);
  const [tag, setTag] = useState<{ width: number; height: number } | null>(null);
  const [screenWidth, setScreenWidth] = useState(Dimensions.get('window').width);
  useEffect(() => {
    const subscription = Dimensions.addEventListener('change', ({ window }) =>
      setScreenWidth(window.width),
    );
    return () => subscription.remove();
  }, []);

  let placement: TagPlacement | null = null;
  if (menu && row && tag) {
    const onScreen: Frame = { ...menu, x: menu.x + offsetX };
    const placed = placeCoachTag(onScreen, row, tag, screenWidth);
    placement = { ...placed, x: placed.x - offsetX };
  }
  const inside = placement?.mode === 'inside';

  return (
    <>
      <Animated.View
        entering={ZoomIn.duration(MENU_GROW_MS)}
        exiting={FadeOut.duration(160)}
        style={p.menuWrap}
        onLayout={(event) => setMenu(event.nativeEvent.layout)}
      >
        <Pressable cssInterop={false} onPress={onClose} accessible={false} style={p.menu}>
          {ROWS.map((item) => {
            const live = item.id === target;
            return (
              <Pressable
                key={item.id}
                cssInterop={false}
                accessibilityRole="button"
                accessibilityState={{ disabled: !live }}
                accessibilityHint={live ? t('coachPick') : undefined}
                onPress={live ? onPick : undefined}
                onLayout={live ? (event) => setRow(event.nativeEvent.layout) : undefined}
                style={[p.row, live && p.rowHighlight]}
              >
                <View style={p.tile}>
                  <Glyph name={item.glyph} size={14} color={colors.ink} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={p.rowTitle} numberOfLines={1}>
                    {t(item.title)}
                  </Text>
                  {live && inside ? null : (
                    <Text style={p.rowBody} numberOfLines={1}>
                      {t(item.body, { language })}
                    </Text>
                  )}
                </View>
              </Pressable>
            );
          })}
        </Pressable>
      </Animated.View>
      {/* Measured once unseen, then shown in place; never focusable, the row says what to do. */}
      <Animated.View
        key={placement ? `${placement.points}` : 'measure'}
        entering={placement ? FadeIn.delay(MENU_GROW_MS).duration(TAG_FADE_MS) : undefined}
        exiting={FadeOut.duration(160)}
        pointerEvents="none"
        importantForAccessibility="no-hide-descendants"
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          if (!tag || tag.width !== width || tag.height !== height) setTag({ width, height });
        }}
        style={[
          p.tagWrap,
          placement ? { left: placement.x, top: placement.y } : { left: 0, top: 0, opacity: 0 },
        ]}
      >
        <CoachTag points={placement?.points ?? 'right'} label={t('coachPick')} />
      </Animated.View>
    </>
  );
}

/** OB/Coach tag: brand glass, 12 bold white, "Pick ›" or "‹ Pick". */
function CoachTag({ points, label }: { points: 'left' | 'right'; label: string }) {
  return (
    <LinearGradient colors={GLASS_GRADIENT} style={p.tag}>
      <View pointerEvents="none" style={p.tagRim} />
      <Text style={p.tagLabel}>{points === 'right' ? `${label} ›` : `‹ ${label}`}</Text>
    </LinearGradient>
  );
}

const p = StyleSheet.create({
  card: { ...glassEdge, borderRadius: 20, overflow: 'hidden' },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: colors.surface2,
  },
  appIcon: { width: 24, height: 24, borderRadius: 6 },
  appName: { flex: 1, fontSize: 16, fontFamily: AppFont.semibold, color: colors.ink },
  send: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hint: { fontSize: 17, lineHeight: 22, textAlign: 'right', fontFamily: AppFont.medium },
  done: { fontSize: 22, lineHeight: 29, fontFamily: AppFont.bold, letterSpacing: -0.3 },
  say: { ...glassEdge, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 14, gap: 6 },
  sayLabel: {
    fontSize: 11,
    letterSpacing: 0.8,
    color: colors.tertiary,
    fontFamily: AppFont.medium,
  },
  sayQuote: { fontSize: 17, lineHeight: 24, color: colors.ink, fontFamily: AppFont.medium },
  menuWrap: { alignSelf: 'flex-end', transformOrigin: 'bottom right' },
  menu: {
    ...glassEdge,
    width: 208,
    padding: 6,
    gap: 2,
    borderRadius: 20,
  },
  row: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 8,
    paddingRight: 10,
    borderRadius: 14,
  },
  rowHighlight: { backgroundColor: 'rgba(21,75,212,0.12)' },
  tile: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: '#F2F1EF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: 14, fontFamily: AppFont.medium, color: '#181714' },
  rowBody: { fontSize: 12, color: '#6E6D69' },
  tagWrap: { position: 'absolute' },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: 'hidden' },
  tagRim: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 6,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
  },
  tagLabel: { fontSize: 12, fontFamily: AppFont.bold, color: '#FFFFFF' },
});
