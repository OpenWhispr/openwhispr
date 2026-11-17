import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { create } from 'zustand';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { home, type } from '../home/kit';
import { noOrphan, useSettingsT } from './strings';

/** Figma "Android · Settings" tokens on top of the shared Home tokens. */
export const settings = {
  ...home,
  success: '#1F9D55',
  rowValue: { fontSize: 17, lineHeight: 24, color: home.tertiary },
  title: { fontSize: 17, lineHeight: 22, fontWeight: '500' as const, color: home.text },
  subtitle: { fontSize: 13, lineHeight: 18, color: home.secondary },
  tabular: { fontVariant: ['tabular-nums' as const] },
};

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

/** Figma Navigation/Header: glass back button, centred title, optional action on the right. */
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
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: home.canvas }}
      edges={['top', 'left', 'right', 'bottom']}
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
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            accessibilityLabel={t('back')}
            hitSlop={6}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)'))}
            style={({ pressed }) => ({
              width: 36,
              height: 36,
              borderRadius: 18,
              backgroundColor: 'rgba(255,255,255,0.72)',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <SystemIcon name="chevron.left" mdName="ChevronLeft" size={22} color={home.accent} />
          </Pressable>
        </View>
        <Text
          accessibilityRole="header"
          numberOfLines={1}
          style={[settings.title, { flex: 1, textAlign: 'center' }]}
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
              style={({ pressed }) => ({
                minHeight: 36,
                paddingHorizontal: 12,
                borderRadius: 18,
                backgroundColor: 'rgba(255,255,255,0.72)',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={[type.subhead, { fontWeight: '500' }]}>{right.label}</Text>
            </Pressable>
          )}
        </View>
      </View>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 16,
            paddingBottom: 32,
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

export const cardStyle: ViewStyle = {
  backgroundColor: home.surface,
  borderWidth: 1,
  borderColor: home.borderDefault,
  borderRadius: 14,
  overflow: 'hidden',
  boxShadow: home.tipShadow,
};

/** Figma List/Card: an uppercase header, one card of rows split by inset dividers, a caption. */
export function Group({
  title,
  footer,
  inset = 56,
  children,
  style,
}: {
  title?: string;
  footer?: string;
  /** Where the dividers start: past the 28 px icon (56), or at the card padding (16). */
  inset?: number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={[{ gap: 12 }, style]}>
      {title && (
        <Text accessibilityRole="header" style={type.section}>
          {title}
        </Text>
      )}
      <View style={cardStyle}>
        {rows.map((row, index) => (
          <React.Fragment key={index}>
            {index > 0 && (
              <View
                style={{
                  height: 1,
                  marginLeft: inset,
                  backgroundColor: home.divider,
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

/** "Recommended": accent text on the tint, or white behind it on a selected (tinted) row. */
export function Badge({ label, onSelected }: { label: string; onSelected?: boolean }) {
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: onSelected ? home.surface : home.tint,
      }}
    >
      <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '500', color: home.accent }}>
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
      <Animated.View
        style={{
          width: 64,
          height: 28,
          borderRadius: 999,
          padding: 2,
          backgroundColor: position.interpolate({
            inputRange: [0, 1],
            outputRange: [home.fill, home.accent],
          }),
        }}
      >
        <Animated.View
          style={{
            width: 39,
            height: 24,
            borderRadius: 999,
            backgroundColor: home.surface,
            boxShadow: '0px 2px 4px rgba(0,0,0,0.12), 0px 0px 1px rgba(0,0,0,0.04)',
            transform: [
              { translateX: position.interpolate({ inputRange: [0, 1], outputRange: [0, 21] }) },
            ],
          }}
        />
      </Animated.View>
    </Pressable>
  );
}

/** Figma List/Card row: icon, title (+ badge), optional line under it, value, then a chevron, switch or slot. */
export function ListRow({
  icon,
  leading,
  title,
  badge,
  subtitle,
  value,
  valueAccent,
  trailing,
  toggle,
  onPress,
  selected,
  dimmed,
  destructive,
  accessibilityLabel,
  subtitleStyle,
}: {
  icon?: LucideIconName;
  leading?: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  subtitle?: React.ReactNode;
  value?: string;
  valueAccent?: boolean;
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
  const ink = destructive ? home.error : home.text;
  const body = (
    <>
      {leading ??
        (icon && (
          <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
            <SystemIcon
              name="circle"
              mdName={icon}
              size={20}
              color={destructive ? home.error : home.text}
            />
          </View>
        ))}
      <View style={{ flex: 1, gap: 2, justifyContent: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text
            textBreakStrategy="balanced"
            style={[settings.title, { color: ink, flexShrink: 1 }]}
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
          style={[settings.rowValue, { maxWidth: '45%' }, valueAccent && { color: home.accent }]}
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
    paddingHorizontal: 16,
    paddingVertical: 14,
    minHeight: 56,
    backgroundColor: selected ? home.tint : undefined,
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
      style={({ pressed }) => [rowStyle, pressed && { backgroundColor: home.fill }]}
    >
      {body}
    </Pressable>
  );
}

/** Full-width pill in a card's place: Sign out, Choose a short recording. */
export function PillAction({
  label,
  icon,
  onPress,
  destructive,
  primary,
  disabled,
}: {
  label: string;
  icon?: LucideIconName;
  onPress: () => void;
  destructive?: boolean;
  primary?: boolean;
  disabled?: boolean;
}) {
  const color = primary ? '#FFFFFF' : destructive ? home.error : home.text;
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: 44,
          borderRadius: 999,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          paddingHorizontal: 16,
          backgroundColor: primary ? undefined : home.surface,
          borderWidth: primary ? 0 : 1,
          borderColor: home.borderSubtle,
          boxShadow: primary ? undefined : home.cardShadow,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
        primary && {
          experimental_backgroundImage: 'linear-gradient(180deg, #5588f0 0%, #3466e2 100%)',
          boxShadow:
            'inset 0px 1px 0px rgba(255,255,255,0.6), inset 0px 0px 0px 1px rgba(255,255,255,0.16), inset 0px -1px 1px rgba(0,0,0,0.12)',
        },
      ]}
    >
      {icon && <SystemIcon name="circle" mdName={icon} size={18} color={color} />}
      <Text style={[type.subhead, { color, fontWeight: '500' }]}>{label}</Text>
    </Pressable>
  );
}

/** Figma slider: a 4 px track that fills with the accent and a white knob, 24 tall to touch. */
export function SettingsSlider({
  value,
  min,
  max,
  step,
  onChange,
  onRelease,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onRelease?: (value: number) => void;
  label: string;
}) {
  const [width, setWidth] = useState(0);
  const latest = useRef({ width, onChange, onRelease, value });
  latest.current = { width, onChange, onRelease, value };
  const fromX = (x: number) => {
    const ratio = Math.min(1, Math.max(0, x / Math.max(1, latest.current.width)));
    return Math.round((min + ratio * (max - min)) / step) * step;
  };
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => latest.current.onChange(fromX(event.nativeEvent.locationX)),
      onPanResponderMove: (event) => latest.current.onChange(fromX(event.nativeEvent.locationX)),
      onPanResponderRelease: () => latest.current.onRelease?.(latest.current.value),
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
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min, max, now: value }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) =>
        nudge(event.nativeEvent.actionName === 'increment' ? 1 : -1)
      }
      onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
      style={{ flex: 1, height: 24, justifyContent: 'center' }}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: home.fill }}>
        <View
          style={{
            width: `${ratio * 100}%`,
            height: 4,
            borderRadius: 2,
            backgroundColor: home.accent,
          }}
        />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: Math.max(0, ratio * width - 12),
          width: 24,
          height: 24,
          borderRadius: 12,
          backgroundColor: home.surface,
          borderWidth: 1,
          borderColor: home.borderSubtle,
          boxShadow: '0px 2px 6px rgba(0,0,0,0.16)',
        }}
      />
    </View>
  );
}

type ToastTone = 'success' | 'error' | 'neutral';
export const useSettingsToast = create<{ message: string; tone: ToastTone; id: number }>(() => ({
  message: '',
  tone: 'neutral',
  id: 0,
}));
/** Confirmations are a dark glass pill at the bottom of the screen. */
export function showToast(message: string, tone: ToastTone = 'success') {
  useSettingsToast.setState((state) => ({ message, tone, id: state.id + 1 }));
}

/** Mounted once at the root, so a toast survives the screen that raised it going away. */
export function SettingsToastHost() {
  const { message, tone, id } = useSettingsToast();
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
      () =>
        Animated.timing(opacity, {
          toValue: 0,
          duration: reduceMotion ? 0 : 180,
          useNativeDriver: true,
        }).start(),
      2400,
    );
    return () => clearTimeout(timer);
  }, [id, message, reduceMotion, opacity, lift]);
  if (!id) return null;
  return (
    <SafeAreaView
      edges={['bottom']}
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' }}
    >
      <Animated.View
        importantForAccessibility="no-hide-descendants"
        style={{
          marginBottom: 24,
          marginHorizontal: 24,
          opacity,
          transform: [{ translateY: lift }],
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingLeft: tone === 'neutral' ? 16 : 10,
          paddingRight: 16,
          paddingVertical: 10,
          borderRadius: 999,
          backgroundColor: 'rgba(28,27,25,0.92)',
          borderTopWidth: 1,
          borderTopColor: 'rgba(255,255,255,0.14)',
          boxShadow: home.floatingShadow,
        }}
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
                  : 'linear-gradient(180deg, #f2665c 0%, #d8352a 100%)',
              boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.5)',
            }}
          >
            {tone === 'success' ? (
              <SystemIcon name="checkmark" mdName="Check" size={12} color="#FFFFFF" />
            ) : (
              <Text style={{ color: '#FFFFFF', fontSize: 12, lineHeight: 14, fontWeight: '700' }}>
                !
              </Text>
            )}
          </View>
        )}
        <Text
          textBreakStrategy="balanced"
          style={{
            color: '#FFFFFF',
            fontSize: 15,
            lineHeight: 20,
            fontWeight: '500',
            flexShrink: 1,
          }}
        >
          {message}
        </Text>
      </Animated.View>
    </SafeAreaView>
  );
}

/** A bottom sheet over a dimmed screen; Android back and a tap on the dim close it. */
export function BottomSheet({
  visible,
  onClose,
  title,
  body,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  body?: string;
  children: React.ReactNode;
}) {
  const t = useSettingsT();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('cancel')}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.32)' }}
      />
      <SafeAreaView
        edges={['bottom']}
        style={{
          backgroundColor: home.canvas,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          paddingHorizontal: 16,
          paddingTop: 8,
          paddingBottom: 16,
          gap: 16,
        }}
      >
        <View
          style={{
            alignSelf: 'center',
            width: 36,
            height: 5,
            borderRadius: 3,
            backgroundColor: home.borderDefault,
          }}
        />
        <View style={{ gap: 6 }}>
          <Text
            accessibilityRole="header"
            style={[settings.title, { fontSize: 20, lineHeight: 26 }]}
          >
            {title}
          </Text>
          {body && (
            <Text textBreakStrategy="balanced" style={[type.subhead, { color: home.secondary }]}>
              {noOrphan(body)}
            </Text>
          )}
        </View>
        {children}
      </SafeAreaView>
    </Modal>
  );
}

/** A text button in the accent colour (Not now, sheet actions). */
export function TextAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Text style={[type.subhead, { color: home.accent, fontWeight: '500' }]}>{label}</Text>
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
