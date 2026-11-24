import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useWindowDimensions,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { home, type } from '../home/kit';
import { settings, showToast, useReduceMotion } from '../settings/kit';
import { KeyCheckMark } from '../settings/KeyCheckMark';
import type { KeyCheckState } from '../settings/keyCheck';
import { Radio } from '../settings/ModelListRow';
import { noOrphan } from '../settings/strings';
import type { SheetTask } from '../settings/ownKey';
import { raised, raisedPressed } from '../theme';
import {
  CountBadge,
  PLACE_ICON,
  ProviderMark,
  TASK_ICON,
  Tag,
  Tile,
  edgeCard,
  look,
  sectionLabel,
} from './look';
import { TASK_TITLE, type Place, type Source } from './places';
import type { FableT } from './strings';

/** A task inside a place's card: its icon and name, Meetings with a Live or After tag. */
export function TaskChip({
  label,
  icon,
  tag,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  icon: LucideIconName;
  tag?: { label: string; neutral?: boolean };
  accessibilityLabel?: string;
  onPress?: () => void;
}) {
  const body = (
    <>
      <SystemIcon name="circle" mdName={icon} size={16} color={home.secondary} />
      <Text style={[type.subhead, { fontSize: 14, lineHeight: 18, fontWeight: '500' }]}>
        {label}
      </Text>
      {tag && <Tag label={tag.label} neutral={tag.neutral} />}
    </>
  );
  // Raised (D9): tapping a task chip moves the task.
  const chip = (pressed: boolean): StyleProp<ViewStyle> => [
    raised,
    {
      minHeight: 32,
      paddingVertical: 6,
      paddingLeft: 8,
      paddingRight: 12,
      borderRadius: 999,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    pressed && raisedPressed,
  ];
  if (!onPress)
    return (
      <View accessible accessibilityLabel={accessibilityLabel ?? label} style={chip(false)}>
        {body}
      </View>
    );
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      style={({ pressed }) => chip(pressed)}
    >
      {body}
    </Pressable>
  );
}

/** A task's chip as a place shows it: Meetings is Live everywhere but on device (After). */
export function taskChip(t: FableT, task: SheetTask, place: Place) {
  return {
    label: t(TASK_TITLE[task]),
    icon: TASK_ICON[task],
    tag:
      task === 'meeting'
        ? place === 'device'
          ? { label: t('after'), neutral: true }
          : { label: t('live') }
        : undefined,
    accessibilityLabel: chipLabel(t, task, place),
  };
}

export function ChipRow({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
}

/** A place's heading: its tile (glossy while it runs a task), name with "N tasks", one line. */
export function PlaceHeader({
  place,
  title,
  body,
  count,
}: {
  place: Place;
  title: string;
  body: string;
  /** "3 tasks", shown only while the place runs something. */
  count?: string;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <Tile kind={count ? 'glass' : 'idle'} icon={PLACE_ICON[place]} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text accessibilityRole="header" style={[settings.title, { flexShrink: 1 }]}>
            {title}
          </Text>
          {count && <CountBadge label={count} />}
        </View>
        <Text style={settings.subtitle}>{noOrphan(body)}</Text>
      </View>
    </View>
  );
}

export const Divider = () => (
  <View style={{ height: 1, marginHorizontal: 14, backgroundColor: look.hairline }} />
);

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
  /** A place's icon in a tile (blue once picked), or a provider's logo. */
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
        backgroundColor: selected ? look.pickedRow : pressed ? home.canvas : undefined,
        opacity: disabled ? 0.45 : 1,
      })}
    >
      {leading ?? (icon && <Tile kind={selected ? 'sel' : 'idle'} icon={icon} />)}
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={[settings.title, { flexShrink: 1 }]}>{title}</Text>
          {tag && <Tag label={tag.label} neutral={tag.neutral} />}
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
        minHeight: 60,
        paddingVertical: 12,
        backgroundColor: pressed ? home.canvas : undefined,
      })}
    >
      <Tile kind="sel" icon="Plus" />
      <Text style={[settings.title, { color: home.accent }]}>{label}</Text>
    </Pressable>
  );
}

/** A card of rows in a sheet, split by inset dividers. */
export function SheetCard({ children }: { children: React.ReactNode }) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={edgeCard}>
      {rows.map((row, index) => (
        <React.Fragment key={index}>
          {index > 0 && <Divider />}
          {row}
        </React.Fragment>
      ))}
    </View>
  );
}

/** An uppercase label over a sheet's section, with the provider's mark when it names one. */
export function SectionLabel({ children, source }: { children: string; source?: Source }) {
  const label = (
    <Text accessibilityRole="header" style={sectionLabel}>
      {children}
    </Text>
  );
  if (!source) return <View style={{ marginBottom: -2 }}>{label}</View>;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: -2 }}>
      <ProviderMark source={source} size={14} />
      {label}
    </View>
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
  leading,
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
  /** The provider's mark before the value (the Provider field). */
  leading?: React.ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const box = (
    <View
      style={{
        minHeight: 50,
        borderRadius: 12,
        // An error's 1.5 px ring takes the extra half pixel from the padding, so nothing shifts.
        borderWidth: failed ? 1.5 : 1,
        borderColor: failed ? look.error : focused ? home.accent : look.fieldHairline,
        backgroundColor: home.surface,
        boxShadow: look.edgeShadow,
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: failed ? 11.5 : 12,
        paddingRight: failed ? 11.5 : 12,
        gap: 10,
      }}
    >
      {leading}
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
        <Text style={[type.footnote, { color: home.secondary, fontWeight: '500' }]}>{label}</Text>
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

/** The reason under a refused key or an unreachable server, in red or grey. */
export function Reason({ text, failed }: { text: string; failed: boolean }) {
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={[type.subhead, { fontSize: 14, color: failed ? look.error : home.secondary }]}
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
