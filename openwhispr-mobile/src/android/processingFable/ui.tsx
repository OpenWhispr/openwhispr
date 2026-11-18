import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { home, type } from '../home/kit';
import { Badge, cardStyle, settings, showToast, useReduceMotion } from '../settings/kit';
import { KEY_CHECK_COLORS, KeyCheckMark } from '../settings/KeyCheckMark';
import type { KeyCheckState } from '../settings/keyCheck';
import { Radio } from '../settings/ModelListRow';
import { noOrphan } from '../settings/strings';
import type { SheetTask } from '../settings/ownKey';
import { TASK_TITLE, type Place } from './places';
import type { FableT } from './strings';

/** A task inside a place's card. Tapping it opens that task's sheet. */
export function TaskChip({ label, onPress }: { label: string; onPress?: () => void }) {
  if (!onPress)
    return (
      <View
        style={{
          minHeight: 36,
          paddingHorizontal: 12,
          borderRadius: 999,
          justifyContent: 'center',
          backgroundColor: home.fill,
        }}
      >
        <Text style={[type.subhead, { color: home.text, fontWeight: '500' }]}>{label}</Text>
      </View>
    );
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 36,
        paddingHorizontal: 12,
        borderRadius: 999,
        justifyContent: 'center',
        backgroundColor: pressed ? home.borderSubtle : home.fill,
      })}
    >
      <Text style={[type.subhead, { color: home.text, fontWeight: '500' }]}>{label}</Text>
    </Pressable>
  );
}

export function ChipRow({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
}

/** The flat button inside a card ("Use for everything", "Add a key"): tint, accent text. */
export function FlatButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: 999,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: home.tint,
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <Text style={[type.subhead, { color: home.accent, fontWeight: '500' }]}>{label}</Text>
    </Pressable>
  );
}

/** A place's heading: icon, name and one line under it. */
export function PlaceHeader({
  icon,
  title,
  body,
}: {
  icon: LucideIconName;
  title: string;
  body: string;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
      <View style={{ width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
        <SystemIcon name="circle" mdName={icon} size={20} color={home.text} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text accessibilityRole="header" style={settings.title}>
          {title}
        </Text>
        <Text style={settings.subtitle}>{noOrphan(body)}</Text>
      </View>
    </View>
  );
}

export const Divider = () => <View style={{ height: 1, backgroundColor: home.divider }} />;

/** One choice in a sheet's radio list: icon, title with a tag, a line, the radio on the right. */
export function RadioRow({
  icon,
  title,
  tag,
  subtitle,
  selected,
  disabled,
  onPress,
  leading,
}: {
  icon?: LucideIconName;
  title: string;
  tag?: { label: string; neutral?: boolean };
  subtitle?: string;
  selected: boolean;
  disabled?: boolean;
  onPress?: () => void;
  leading?: React.ReactNode;
}) {
  const reduceMotion = useReduceMotion();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: Boolean(disabled) }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        paddingVertical: 12,
        minHeight: 60,
        backgroundColor: selected ? home.tint : pressed ? home.fill : undefined,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      {leading ??
        (icon && (
          <View style={{ width: 28, alignItems: 'center' }}>
            <SystemIcon name="circle" mdName={icon} size={20} color={home.text} />
          </View>
        ))}
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={[settings.title, { flexShrink: 1 }]}>{title}</Text>
          {tag && <Badge label={tag.label} neutral={tag.neutral} onSelected={selected} />}
        </View>
        {subtitle ? <Text style={settings.subtitle}>{noOrphan(subtitle)}</Text> : null}
      </View>
      <Radio on={selected} reduceMotion={reduceMotion} />
    </Pressable>
  );
}

/** "+ Add a key" as the last row of a list. */
export function AddRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        minHeight: 52,
        backgroundColor: pressed ? home.fill : undefined,
      })}
    >
      <View style={{ width: 28, alignItems: 'center' }}>
        <SystemIcon name="plus" mdName="Plus" size={20} color={home.accent} />
      </View>
      <Text style={[settings.title, { color: home.accent }]}>{label}</Text>
    </Pressable>
  );
}

/** A card of rows in a sheet, split by inset dividers. */
export function SheetCard({ children }: { children: React.ReactNode }) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={cardStyle}>
      {rows.map((row, index) => (
        <React.Fragment key={index}>
          {index > 0 && (
            <View style={{ height: 1, marginLeft: 16, backgroundColor: home.divider }} />
          )}
          {row}
        </React.Fragment>
      ))}
    </View>
  );
}

/** An uppercase label over a sheet's section. */
export function SectionLabel({ children }: { children: string }) {
  return (
    <Text accessibilityRole="header" style={[type.section, { marginBottom: -4 }]}>
      {children}
    </Text>
  );
}

/**
 * A page that slid into a sheet: it comes in 24 px from the side, fading (200 ms). The page
 * scrolls once it's taller than the screen allows, padded so no card's shadow is cut.
 */
export function SlideIn({
  pageKey,
  back,
  children,
}: {
  pageKey: string;
  back?: boolean;
  children: React.ReactNode;
}) {
  const reduceMotion = useReduceMotion();
  const { height } = useWindowDimensions();
  const value = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduceMotion) return;
    value.setValue(0);
    Animated.timing(value, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [pageKey, reduceMotion, value]);
  return (
    <Animated.View
      style={{
        opacity: value,
        transform: [
          {
            translateX: value.interpolate({
              inputRange: [0, 1],
              outputRange: [back ? -24 : 24, 0],
            }),
          },
        ],
      }}
    >
      <ScrollView
        // The status bar, the sheet's handle and title, and a little of the screen above stay.
        style={{ maxHeight: height - 200, marginHorizontal: -16, marginVertical: -8 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 16 }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </Animated.View>
  );
}

/** A labelled field (Provider, API key, Server address), with the key check's mark inside. */
export function Field({
  label,
  action,
  value,
  onChangeText,
  placeholder,
  secure,
  locked,
  mark,
  failed,
  keyboardType,
  onPress,
  chevron,
}: {
  label: string;
  action?: { label: string; onPress: () => void };
  value: string;
  onChangeText?: (value: string) => void;
  placeholder?: string;
  secure?: boolean;
  /** Shown as text: a checked key, or a field that opens a list. */
  locked?: boolean;
  mark?: KeyCheckState;
  failed?: boolean;
  keyboardType?: 'default' | 'url';
  onPress?: () => void;
  chevron?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const box = (
    <View
      style={{
        minHeight: 50,
        borderRadius: 14,
        borderWidth: 1.5,
        borderColor: failed ? KEY_CHECK_COLORS.failed : focused ? home.accent : home.borderSubtle,
        backgroundColor: home.surface,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: 16,
        paddingRight: 14,
        gap: 10,
      }}
    >
      {locked || onPress ? (
        <Text
          style={[settings.title, { flex: 1, fontWeight: '400', paddingVertical: 12 }]}
          numberOfLines={1}
        >
          {value}
        </Text>
      ) : (
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={home.tertiary}
          secureTextEntry={secure}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          keyboardType={keyboardType === 'url' ? 'url' : 'default'}
          accessibilityLabel={label}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={[settings.title, { flex: 1, fontWeight: '400', paddingVertical: 12 }]}
        />
      )}
      {mark && mark !== 'idle' && <KeyCheckMark state={mark} animate={!locked} />}
      {chevron && (
        <SystemIcon name="chevron.down" mdName="ChevronDown" size={20} color={home.secondary} />
      )}
    </View>
  );
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={[type.footnote, { color: home.secondary }]}>{label}</Text>
        {action && (
          <Pressable
            cssInterop={false}
            accessibilityRole="button"
            hitSlop={12}
            onPress={action.onPress}
          >
            <Text style={[type.footnote, { color: home.accent, fontWeight: '500' }]}>
              {action.label}
            </Text>
          </Pressable>
        )}
      </View>
      {onPress ? (
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value}`}
          onPress={onPress}
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          {box}
        </Pressable>
      ) : (
        box
      )}
    </View>
  );
}

/** One line with a green tick ("Runs all 5 tasks. Meetings run live."). */
export function TickLine({ text }: { text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-start' }}>
      <View style={{ paddingTop: 1 }}>
        <SystemIcon name="checkmark" mdName="Check" size={16} color={KEY_CHECK_COLORS.connected} />
      </View>
      <Text style={[type.subhead, { color: home.secondary, flex: 1 }]}>{noOrphan(text)}</Text>
    </View>
  );
}

/** The reason under a refused key or an unreachable server, in red or grey. */
export function Reason({ text, failed }: { text: string; failed: boolean }) {
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={[type.subhead, { color: failed ? KEY_CHECK_COLORS.failed : home.secondary }]}
    >
      {noOrphan(text)}
    </Text>
  );
}

/** "Dictation", or "Meetings · live" / "Meetings · after" depending on the place. */
export function chipLabel(t: FableT, task: SheetTask, place: Place): string {
  if (task !== 'meeting') return t(TASK_TITLE[task]);
  return t(place === 'device' ? 'meetingsAfter' : 'meetingsLive');
}

/** The undo toast every bulk move shows at the bottom. */
export function confirmWithUndo(t: FableT, message: string, undo: () => Promise<void>) {
  showToast(message, 'success', {
    label: t('undo'),
    onPress: () => void undo().catch(() => undefined),
    onClose: () => undefined,
  });
}

export type { FableT };
