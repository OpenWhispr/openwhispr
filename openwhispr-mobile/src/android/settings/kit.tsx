import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { create } from 'zustand';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { homeLook, useHome } from '../home/kit';
import { useSettingsLook } from './look';
import { noOrphan, useSettingsT } from './strings';
import type { Scheme } from '../theme';
import { useNavigationBar, useNavigationBarCanvas } from '../navigationBar';
import { themeFor, useTheme, type AndroidTheme } from '../ThemeProvider';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import { TAB_BAR_HEIGHT } from '../tabBar';

/** Figma "Android · Settings" tokens on top of the shared Home tokens, for a theme. */
function buildSettings(theme: AndroidTheme) {
  const home = homeLook(theme).c;
  return {
    ...home,
    success: theme.tokens.success,
    rowValue: { fontSize: 15, lineHeight: 24, color: home.tertiary },
    title: { fontSize: 17, lineHeight: 22, fontWeight: '500' as const, color: home.text },
    rowTitle: { fontSize: 16, lineHeight: 22, fontWeight: '500' as const, color: home.text },
    subtitle: { fontSize: 13, lineHeight: 18, color: home.secondary },
    tabular: { fontVariant: ['tabular-nums' as const] },
  };
}
export type SettingsTokens = ReturnType<typeof buildSettings>;
const settingsByScheme: Partial<Record<Scheme, SettingsTokens>> = {};
/** Settings' tokens for a theme, built once per scheme. */
export function settingsFor(theme: AndroidTheme): SettingsTokens {
  return (settingsByScheme[theme.scheme] ??= buildSettings(theme));
}
/** Settings' tokens for the scheme in use. Read them at render; a switch re-renders in place. */
export function useSettings(): SettingsTokens {
  return settingsFor(useTheme());
}
/** @deprecated Light only, for files not moved yet: read `useSettings()`. */
export const settings = settingsFor(themeFor('light'));

/** Android's "Remove animations": every motion jumps to its end state while it is on. */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => mounted && setReduce(value))
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/** Figma Navigation/Header: a raised back button, a centred title, an optional raised action on the right. */
export function SettingsPage({
  title,
  right,
  children,
  scroll = true,
}: {
  title: string;
  right?: { label: string; onPress: () => void };
  children: React.ReactNode;
  scroll?: boolean;
}) {
  const t = useSettingsT();
  // Gestures: edge to edge, the list scrolls under the handle. Buttons: the bar is part of the
  // page (canvas colour) and nothing scrolls under it.
  const { buttons, inset } = useNavigationBar();
  const th = useTheme();
  const settings = useSettings();
  const { type } = useHome();
  const ink = th.tokens.ink;
  useNavigationBarCanvas(th.tokens.canvas);
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: th.tokens.canvas }}
      edges={buttons ? ['top', 'left', 'right', 'bottom'] : ['top', 'left', 'right']}
    >
      <View
        style={{
          height: 52,
          paddingHorizontal: 16,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <View style={{ width: 84 }}>
          {/* With nothing behind, back goes Home: '/(tabs)' alone resolves to the hidden Chat tab. */}
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityLabel={t('back')}
            hitSlop={6}
            onPress={() =>
              router.canGoBack() ? router.back() : router.replace('/(tabs)/(record)')
            }
            style={({ pressed }) => [
              th.raised,
              {
                width: 36,
                height: 36,
                borderRadius: 18,
                alignItems: 'center',
                justifyContent: 'center',
              },
              pressed && th.raisedPressed,
            ]}
          >
            <SystemIcon name="chevron.left" mdName="ChevronLeft" size={22} color={ink} />
          </Pressable>
        </View>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          // An address as the title (a calendar account) shrinks to fit when it's a little too
          // long; a longer one is cut in the middle. Android ignores minimumFontScale.
          adjustsFontSizeToFit={title.length <= 24}
          ellipsizeMode="middle"
          style={[settings.title, { color: ink, flex: 1, textAlign: 'center', lineHeight: 24 }]}
        >
          {title}
        </Text>
        <View style={{ width: 84, alignItems: 'flex-end' }}>
          {right && (
            <Pressable
              cssInterop={false}
              accessibilityRole="button"
              onPress={right.onPress}
              hitSlop={6}
              style={({ pressed }) => [
                th.raised,
                {
                  minHeight: 36,
                  paddingHorizontal: 16,
                  borderRadius: 18,
                  justifyContent: 'center',
                },
                pressed && th.raisedPressed,
              ]}
            >
              <Text style={[type.subhead, { color: ink, fontWeight: '500' }]}>{right.label}</Text>
            </Pressable>
          )}
        </View>
      </View>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 32 + (buttons ? 0 : inset),
            gap: 20,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 16, paddingTop: 16, gap: 20 }}>{children}</View>
      )}
    </SafeAreaView>
  );
}

/** @deprecated Light only: read `useSettingsLook().edgeCard`. */
export const cardStyle: ViewStyle = {
  ...themeFor('light').flat,
  borderRadius: 16,
  overflow: 'hidden',
};

/** Figma List/Card: an uppercase header, one card of rows split by inset dividers, a caption. */
export function Group({
  title,
  footer,
  inset = 62,
  children,
  style,
}: {
  title?: string;
  footer?: string;
  /** Where the dividers start: past the icon tile (62), or at the row's padding (14). */
  inset?: number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const rows = React.Children.toArray(children).filter(Boolean);
  const { look, edgeCard, sectionLabel } = useSettingsLook();
  const settings = useSettings();
  return (
    <View style={[{ gap: 12 }, style]}>
      {title && (
        <Text accessibilityRole="header" style={sectionLabel}>
          {title}
        </Text>
      )}
      <View style={edgeCard}>
        {rows.map((row, index) => (
          <React.Fragment key={index}>
            {index > 0 && (
              <View
                style={{
                  height: 1,
                  marginLeft: inset,
                  backgroundColor: look.hairline,
                }}
              />
            )}
            {row}
          </React.Fragment>
        ))}
      </View>
      {footer && (
        <Text textBreakStrategy="balanced" style={[settings.subtitle, { paddingHorizontal: 4 }]}>
          {noOrphan(footer)}
        </Text>
      )}
    </View>
  );
}

/** "Recommended": accent text on the tint, or a white glass-edged tag on a selected (tinted) row. */
export function Badge({
  label,
  onSelected,
  neutral,
}: {
  label: string;
  onSelected?: boolean;
  /** Grey, for a plain fact such as Changed. */
  neutral?: boolean;
}) {
  const { look, edge } = useSettingsLook();
  const home = useSettings();
  return (
    <View
      style={[
        {
          paddingHorizontal: 8,
          paddingVertical: 2,
          borderRadius: 6,
          backgroundColor: neutral ? look.track : look.selFill,
        },
        onSelected && !neutral && edge,
      ]}
    >
      <Text
        style={{
          fontSize: 12,
          lineHeight: 16,
          fontWeight: '500',
          color: neutral ? home.secondary : home.accent,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function Toggle({
  value,
  onValueChange,
  disabled,
  label,
}: {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  const reduceMotion = useReduceMotion();
  const th = useTheme();
  const position = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(position, {
      toValue: value ? 1 : 0,
      duration: reduceMotion ? 0 : 160,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [value, reduceMotion, position]);
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onValueChange(!value)}
      style={{ opacity: disabled ? 0.4 : 1 }}
    >
      <View
        style={{
          width: 64,
          height: 28,
          borderRadius: 999,
          padding: 2,
          ...th.inset,
        }}
      >
        {/* On, the track is the brand glass; it fades in over the grey. */}
        <Animated.View
          pointerEvents="none"
          style={[
            { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: 999 },
            th.glass,
            { opacity: position },
          ]}
        />
        <Animated.View
          style={{
            width: 39,
            height: 24,
            borderRadius: 999,
            ...th.knob,
            transform: [
              { translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, 21] }) },
            ],
          }}
        />
      </View>
    </Pressable>
  );
}

/** Figma List/Card row: icon tile, title (+ badge), optional line under it, value, then a chevron, switch or slot. */
export function ListRow({
  icon,
  leading,
  title,
  badge,
  subtitle,
  value,
  valueAccent,
  valueColor,
  trailing,
  toggle,
  onPress,
  selected,
  dimmed,
  destructive,
  accessibilityLabel,
  subtitleStyle,
  titleColor,
  singleLineTitle,
}: {
  icon?: LucideIconName;
  leading?: React.ReactNode;
  title: string;
  /** A title in its own colour (the blue "Add Google account"). */
  titleColor?: string;
  /** One line, cut in the middle (an email address keeps its domain). */
  singleLineTitle?: boolean;
  badge?: React.ReactNode;
  subtitle?: React.ReactNode;
  value?: string;
  valueAccent?: boolean;
  /** A value in its own colour (amber Reconnect). */
  valueColor?: string;
  /** Replaces the chevron. Pass null for no trailing element. */
  trailing?: React.ReactNode;
  toggle?: { value: boolean; onValueChange: (value: boolean) => void; disabled?: boolean };
  onPress?: () => void;
  selected?: boolean;
  dimmed?: boolean;
  destructive?: boolean;
  accessibilityLabel?: string;
  subtitleStyle?: StyleProp<import('react-native').TextStyle>;
}) {
  const { look } = useSettingsLook();
  const settings = useSettings();
  const home = settings;
  const ink = destructive ? look.error : home.text;
  const titleInk = titleColor ?? ink;
  const body = (
    <>
      {leading ??
        (icon && (
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              backgroundColor: look.idleFill,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <SystemIcon name="circle" mdName={icon} size={18} color={ink} />
          </View>
        ))}
      <View
        style={{ flex: 1, gap: 2, justifyContent: 'center', opacity: toggle?.disabled ? 0.4 : 1 }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            // One-line titles keep their badge beside them and shrink instead.
            flexWrap: singleLineTitle ? 'nowrap' : 'wrap',
          }}
        >
          <Text
            textBreakStrategy="balanced"
            numberOfLines={singleLineTitle ? 1 : undefined}
            ellipsizeMode="middle"
            style={[settings.rowTitle, { color: titleInk, flexShrink: 1 }]}
          >
            {title}
          </Text>
          {badge}
        </View>
        {typeof subtitle === 'string' ? (
          <Text textBreakStrategy="balanced" style={[settings.subtitle, subtitleStyle]}>
            {noOrphan(subtitle)}
          </Text>
        ) : (
          subtitle
        )}
      </View>
      {value !== undefined && (
        <Text
          numberOfLines={1}
          style={[
            settings.rowValue,
            { maxWidth: '45%' },
            valueAccent && { color: home.accent },
            valueColor != null && { color: valueColor },
          ]}
        >
          {value}
        </Text>
      )}
      {toggle ? (
        <Toggle label={title} {...toggle} />
      ) : trailing !== undefined ? (
        trailing
      ) : selected ? (
        <SystemIcon name="checkmark" mdName="Check" size={22} color={home.accent} />
      ) : onPress ? (
        <SystemIcon name="chevron.right" mdName="ChevronRight" size={20} color={home.tertiary} />
      ) : null}
    </>
  );
  const rowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 12,
    paddingBottom: 12,
    paddingLeft: 14,
    paddingRight: 12,
    minHeight: 48,
    backgroundColor: selected ? look.selFill : undefined,
    opacity: dimmed ? 0.45 : 1,
  };
  if (!onPress || toggle)
    return (
      <View style={rowStyle} accessible={!toggle} accessibilityLabel={accessibilityLabel}>
        {body}
      </View>
    );
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: Boolean(selected) }}
      onPress={onPress}
      style={({ pressed }) => [rowStyle, pressed && { backgroundColor: look.idleFill }]}
    >
      {body}
    </Pressable>
  );
}

/**
 * Full-width pill on the canvas: Sign out, Choose a short recording. Primary is the desktop's brand
 * glass with no lift (pressed, it sinks and darkens); the rest are raised white pills.
 */
export function PillAction({
  label,
  icon,
  onPress,
  destructive,
  primary,
  disabled,
  busy,
}: {
  label: string;
  icon?: LucideIconName;
  onPress: () => void;
  destructive?: boolean;
  primary?: boolean;
  disabled?: boolean;
  /** A spinner in place of the label while the action runs. */
  busy?: boolean;
}) {
  const th = useTheme();
  const { look } = useSettingsLook();
  const { c: home, type } = useHome();
  const color = primary ? th.tokens.onGlass : destructive ? look.error : home.text;
  const off = disabled || busy;
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(off), busy: Boolean(busy) }}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: destructive ? 44 : 50,
          borderRadius: 999,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingHorizontal: 20,
          opacity: off ? 0.5 : 1,
        },
        primary ? th.glass : th.raised,
        primary && pressed && !off && th.glassPressed,
        !primary && pressed && !off && th.raisedPressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={color} />
      ) : (
        <>
          {icon && <SystemIcon name="circle" mdName={icon} size={18} color={color} />}
          <Text
            style={
              primary
                ? { color, fontSize: 17, lineHeight: 22, fontWeight: '700' }
                : [type.subhead, { color, lineHeight: 22, fontWeight: '500' }]
            }
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Figma slider: a 6 px track that fills with the brand glass and a white knob, 44 tall to touch. */
export function SettingsSlider({
  value,
  min,
  max,
  step,
  onChange,
  onRelease,
  onActiveChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onRelease?: (value: number) => void;
  /** True while a finger is on the slider. */
  onActiveChange?: (active: boolean) => void;
  label: string;
}) {
  const th = useTheme();
  const [width, setWidth] = useState(0);
  const box = useRef<View>(null);
  // The slider's left edge on screen: touches are measured against it, never against whichever
  // child (knob or track) the finger landed on.
  const left = useRef(0);
  const dragging = useRef(false);
  const latest = useRef({ width, onChange, onRelease, onActiveChange, value });
  latest.current = { width, onChange, onRelease, onActiveChange, value };
  const fromPageX = (pageX: number) => {
    const usable = Math.max(1, latest.current.width - KNOB);
    const ratio = Math.min(1, Math.max(0, (pageX - left.current - KNOB / 2) / usable));
    return Math.round((min + ratio * (max - min)) / step) * step;
  };
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      // Only a sideways drag is the slider's; an up or down swipe scrolls the page.
      onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderTerminationRequest: (_, gesture) =>
        !dragging.current && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderGrant: () => {
        dragging.current = false;
        latest.current.onActiveChange?.(true);
      },
      onPanResponderMove: (event, gesture) => {
        if (!dragging.current && Math.abs(gesture.dx) < 4) return;
        dragging.current = true;
        const next = fromPageX(event.nativeEvent.pageX);
        if (next !== latest.current.value) latest.current.onChange(next);
      },
      // A tap sets the value where it landed; either way the value is committed once, on release.
      onPanResponderRelease: (event, gesture) => {
        const wasDragging = dragging.current;
        dragging.current = false;
        latest.current.onActiveChange?.(false);
        // A swipe that never became a sideways drag (an up or down flick) changes nothing.
        if (!wasDragging && Math.hypot(gesture.dx, gesture.dy) > 8) return;
        const next = fromPageX(event.nativeEvent.pageX);
        if (next !== latest.current.value) latest.current.onChange(next);
        latest.current.onRelease?.(next);
      },
      onPanResponderTerminate: () => {
        dragging.current = false;
        latest.current.onActiveChange?.(false);
      },
    }),
  ).current;
  const ratio = (value - min) / (max - min);
  const nudge = (direction: 1 | -1) => {
    const next = Math.min(max, Math.max(min, value + direction * step));
    onChange(next);
    onRelease?.(next);
  };
  return (
    <View
      ref={box}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) =>
        nudge(event.nativeEvent.actionName === 'increment' ? 1 : -1)
      }
      onLayout={({ nativeEvent }) => {
        setWidth(nativeEvent.layout.width);
        box.current?.measureInWindow((x) => {
          left.current = x;
        });
      }}
      // Taller than it looks, so the finger finds it.
      style={{ flex: 1, height: 44, justifyContent: 'center' }}
      {...responder.panHandlers}
    >
      <View
        pointerEvents="none"
        style={{
          height: 6,
          marginHorizontal: KNOB / 2,
          borderRadius: 3,
          ...th.inset,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${ratio * 100}%`,
            height: 6,
            borderRadius: 3,
            experimental_backgroundImage: th.glass.experimental_backgroundImage,
          }}
        />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: ratio * Math.max(0, width - KNOB),
          width: KNOB,
          height: KNOB,
          borderRadius: KNOB / 2,
          ...th.knob,
        }}
      />
    </View>
  );
}
const KNOB = 24;

/** `learned`: the dictionary learned a word (a blue dot with sparkles, Dictionary's C7). */
type ToastTone = 'success' | 'error' | 'neutral' | 'learned';
/** A snackbar's action. `onClose` runs once it closes without the action: timed out or replaced. */
type ToastAction = { label: string; onPress: () => void; onClose: () => void };
/** `durationMs` overrides the default (5 s with an action); `aboveTabBar` lifts it over the tab bar. */
type ToastOptions = { durationMs?: number; aboveTabBar?: boolean };
export const useSettingsToast = create<{
  message: string;
  tone: ToastTone;
  id: number;
  action?: ToastAction;
  options?: ToastOptions;
}>(() => ({ message: '', tone: 'neutral', id: 0 }));
/**
 * Confirmations are a dark glass pill at the bottom of the screen. With an action it is a 5 s
 * snackbar (Undo); a newer toast closes the one showing.
 */
export function showToast(
  message: string,
  tone: ToastTone = 'success',
  action?: ToastAction,
  options?: ToastOptions,
) {
  useSettingsToast.getState().action?.onClose();
  useSettingsToast.setState((state) => ({ message, tone, action, options, id: state.id + 1 }));
}

/** Mounted once at the root, so a toast survives the screen that raised it going away. */
export function SettingsToastHost() {
  const { message, tone, id, action, options } = useSettingsToast();
  const { tokens: theme, scheme, glass } = useTheme();
  const { inset } = useNavigationBar();
  // With the keyboard up (a note being typed in), the toast sits just above it, not behind it.
  // Android's keyboard height leaves out the navigation bar, as in BottomSheet.
  const keyboard = useKeyboardHeight();
  const reduceMotion = useReduceMotion();
  const opacity = useRef(new Animated.Value(0)).current;
  const lift = useRef(new Animated.Value(16)).current;
  useEffect(() => {
    if (!id) return;
    AccessibilityInfo.announceForAccessibility(message);
    const duration = reduceMotion ? 0 : 200;
    opacity.setValue(0);
    lift.setValue(reduceMotion ? 0 : 16);
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration, useNativeDriver: true }),
      Animated.timing(lift, { toValue: 0, duration, useNativeDriver: true }),
    ]).start();
    const timer = setTimeout(
      () => {
        Animated.timing(opacity, {
          toValue: 0,
          duration: reduceMotion ? 0 : 180,
          useNativeDriver: true,
        }).start();
        if (useSettingsToast.getState().id !== id) return;
        useSettingsToast.getState().action?.onClose();
        useSettingsToast.setState({ action: undefined });
      },
      options?.durationMs ?? (action ? 5000 : 2400),
    );
    return () => clearTimeout(timer);
    // The action belongs to this id; a change of id is what restarts the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, message, reduceMotion, opacity, lift]);
  if (!id) return null;
  return (
    // 16 dp above the gesture handle or the button bar, whichever the phone has.
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom:
          keyboard > 0 ? keyboard + inset : inset + (options?.aboveTabBar ? TAB_BAR_HEIGHT : 0),
        alignItems: 'center',
      }}
    >
      <Animated.View
        pointerEvents={action ? 'auto' : 'none'}
        importantForAccessibility={action ? 'auto' : 'no-hide-descendants'}
        style={[
          {
            marginBottom: 16,
            marginHorizontal: action ? 16 : 24,
            opacity,
            transform: [{ translateY: lift }],
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingLeft: tone === 'neutral' ? 16 : 10,
            paddingRight: action ? 4 : 16,
            paddingVertical: action ? 4 : 10,
            borderRadius: action ? 14 : 999,
            backgroundColor: action ? theme.toastSolid : theme.toast,
            borderTopWidth: 1,
            borderTopColor: theme.toastRim,
            // 12 blur, 4 down: the 16 dp margin holds the whole shadow.
            boxShadow:
              scheme === 'dark' ? '0px 4px 12px rgba(0,0,0,0.45)' : '0px 4px 12px rgba(0,0,0,0.18)',
          },
          action && { alignSelf: 'stretch' },
        ]}
      >
        {tone !== 'neutral' && (
          <View
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              alignItems: 'center',
              justifyContent: 'center',
              experimental_backgroundImage:
                tone === 'success'
                  ? 'linear-gradient(180deg, #4cc47f 0%, #1f9d55 100%)'
                  : tone === 'learned'
                    ? glass.experimental_backgroundImage
                    : 'linear-gradient(180deg, #f2665c 0%, #d8352a 100%)',
              boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.5)',
            }}
          >
            {tone === 'success' ? (
              <SystemIcon name="checkmark" mdName="Check" size={12} color={theme.onToast} />
            ) : tone === 'learned' ? (
              <SystemIcon name="sparkles" mdName="Sparkles" size={11} color={theme.onToast} />
            ) : (
              <Text
                style={{ color: theme.onToast, fontSize: 12, lineHeight: 14, fontWeight: '700' }}
              >
                !
              </Text>
            )}
          </View>
        )}
        <Text
          textBreakStrategy="balanced"
          style={{
            color: theme.onToast,
            fontSize: 15,
            lineHeight: 20,
            fontWeight: '500',
            flexShrink: 1,
            flexGrow: action ? 1 : 0,
          }}
        >
          {message}
        </Text>
        {action && (
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityHint={message}
            onPress={() => {
              action.onPress();
              useSettingsToast.setState({ action: undefined });
              opacity.setValue(0);
            }}
            style={({ pressed }) => ({
              minHeight: 48,
              minWidth: 64,
              paddingHorizontal: 12,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Text
              style={{ color: theme.toastAction, fontSize: 15, lineHeight: 20, fontWeight: '600' }}
            >
              {action.label}
            </Text>
          </Pressable>
        )}
      </Animated.View>
    </View>
  );
}

/**
 * A bottom sheet over a dimmed screen; Android back and a tap on the dim close it. The dim
 * fades in on its own while the sheet slides up, and both play out again before the sheet
 * goes away. The keyboard pushes the sheet up by its own height, never by a guess.
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  body,
  children,
  onBack,
  leading,
  trailing,
  above,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  body?: string;
  children: React.ReactNode;
  /** A page inside the sheet (a list that slid in): a back arrow before the title returns. */
  onBack?: () => void;
  /** A tile before the title (a task's icon, a provider's logo). */
  leading?: React.ReactNode;
  /** After the title, on the right (a close button). */
  trailing?: React.ReactNode;
  /** A tile on its own line above the title (the signed-out sheet's lock). */
  above?: React.ReactNode;
}) {
  const t = useSettingsT();
  const th = useTheme();
  const settings = useSettings();
  const { bodyText } = useSettingsLook();
  const reduceMotion = useReduceMotion();
  const keyboard = useKeyboardHeight(visible);
  // Android's keyboard height leaves out the navigation bar, and a SafeAreaView inside a Modal
  // sees no inset, so with the keyboard up the sheet adds the app's own bottom inset or its last
  // ~48 dp (the button) sits behind the keyboard.
  const { bottom: bottomInset } = useSafeAreaInsets();
  const lift = keyboard > 0 ? keyboard + bottomInset : 0;
  // Stays mounted through the closing animation.
  const [mounted, setMounted] = useState(visible);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) setMounted(true);
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: reduceMotion ? 0 : visible ? 280 : 200,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, reduceMotion, progress]);
  if (!mounted) return null;
  return (
    <Modal
      visible
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Animated.View
        style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, opacity: progress }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('cancel')}
          onPress={onClose}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.40)' }}
        />
      </Animated.View>
      <View style={{ flex: 1, justifyContent: 'flex-end' }} pointerEvents="box-none">
        <Animated.View
          style={{
            backgroundColor: th.tokens.canvas,
            // The safe-area view below can't round its own corners, so this view does.
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            overflow: 'hidden',
            paddingBottom: lift,
            transform: [
              { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [600, 0] }) },
            ],
          }}
        >
          <SafeAreaView
            edges={['bottom']}
            style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 16, gap: 16 }}
          >
            <View
              style={{
                alignSelf: 'center',
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: th.tokens.track,
              }}
            />
            <View style={{ gap: 6 }}>
              {above && <View style={{ marginBottom: 6 }}>{above}</View>}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: leading ? 12 : 8 }}>
                {leading}
                {onBack && (
                  <Pressable
                    cssInterop={false}
                    accessibilityRole="button"
                    accessibilityLabel={t('back')}
                    hitSlop={12}
                    onPress={onBack}
                    style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                  >
                    <SystemIcon
                      name="chevron.left"
                      mdName="ChevronLeft"
                      size={22}
                      color={th.tokens.ink}
                    />
                  </Pressable>
                )}
                <Text
                  accessibilityRole="header"
                  style={[
                    settings.title,
                    { color: th.tokens.ink, fontSize: 20, lineHeight: 26, flexShrink: 1 },
                    trailing ? { flex: 1 } : null,
                  ]}
                >
                  {title}
                </Text>
                {trailing}
              </View>
              {body && (
                <Text textBreakStrategy="balanced" style={[bodyText, { color: th.tokens.ink }]}>
                  {noOrphan(body)}
                </Text>
              )}
            </View>
            {children}
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

/** A text button in the accent colour (Not now, sheet actions). */
export function TextAction({
  label,
  onPress,
  destructive,
}: {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  const { tokens: k } = useTheme();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 50,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text
        style={{
          color: destructive ? k.error : k.accent,
          fontSize: 17,
          lineHeight: 22,
          fontWeight: '500',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** "2 min ago" for Backed up. */
export function relativeTime(iso: string, t: ReturnType<typeof useSettingsT>): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return t('justNow');
  if (minutes < 60) return t('minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', { count: hours });
  return t('daysAgo', { count: Math.floor(hours / 24) });
}
