import React from 'react';
import { Pressable, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useNotesT } from './strings';
import { themeFor, useTheme, type AndroidTheme } from '../ThemeProvider';
import type { Scheme } from '../theme';

/**
 * Notes in OpenWhispr's design language (Figma "section · R · Fable reskin of Notes"): the
 * Settings reskin's glass edge, grey 36 tiles and section labels, on the canvas colour. One per
 * scheme (`useNotesLook()`), so a light/dark switch repaints a note in place.
 */
function buildNotesLook(theme: AndroidTheme) {
  const k = theme.tokens;
  const dark = theme.scheme === 'dark';
  const edge: ViewStyle = theme.flat;
  return {
    theme,
    canvas: k.canvas,
    surface: k.surface,
    surface2: k.surface2,
    selFill: k.selFill,
    idleFill: k.tile,
    track: k.track,
    trackStrong: k.trackStrong,
    error: k.error,
    hairline: k.hairline,
    divider: k.divider,
    fieldHairline: k.fieldHairline,
    disabled: k.disabled,
    onGlass: k.onGlass,
    amber: k.amber,
    success: k.success,
    text: k.ink,
    secondary: k.secondary,
    tertiary: k.tertiary,
    accent: k.accent,
    /** A row being pressed, and the scrim behind a sheet. */
    pressedRow: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    selectedRow: dark ? 'rgba(110,155,255,0.14)' : 'rgba(21,85,212,0.08)',
    title: { fontSize: 28, lineHeight: 39, fontWeight: '500' as const, color: k.ink },
    rowTitle: { fontSize: 17, lineHeight: 24, fontWeight: '500' as const, color: k.ink },
    rowSub: { fontSize: 13, lineHeight: 18, color: k.secondary },
    rowMeta: { fontSize: 12, lineHeight: 16, color: k.tertiary },
    count: { fontSize: 15, lineHeight: 21, color: k.secondary },
    body: { fontSize: 16, lineHeight: 21, color: k.ink },
    /** Uppercase Medium 11 at 6% tracking. */
    sectionLabel: {
      fontSize: 11,
      lineHeight: 16,
      fontWeight: '500' as const,
      color: k.tertiary,
      letterSpacing: 0.66,
      textTransform: 'uppercase' as const,
    } satisfies TextStyle,
    /** The glass edge on a surface: hairline, inner top highlight, soft lift. */
    edge,
    /** A flat card, corners 16. */
    edgeCard: { ...edge, borderRadius: 16, overflow: 'hidden' } satisfies ViewStyle,
    /** A text field: corners 12 and a slightly darker hairline. */
    edgeField: { ...edge, borderRadius: 12, borderColor: k.fieldHairline } satisfies ViewStyle,
    raised: theme.raised,
    raisedPressed: theme.raisedPressed,
    gloss: theme.glass,
    glossPressed: theme.glassPressed,
  };
}

export type NotesLook = ReturnType<typeof buildNotesLook>;

const looks: Partial<Record<Scheme, NotesLook>> = {};

/** Notes' look for a theme, built once per scheme so styles and memo inputs stay stable. */
export function notesLookFor(theme: AndroidTheme): NotesLook {
  return (looks[theme.scheme] ??= buildNotesLook(theme));
}

/** Notes' look for the scheme in use. Read it at render; a switch re-renders in place. */
export function useNotesLook(): NotesLook {
  return notesLookFor(useTheme());
}

/** @deprecated Light only, for files outside Notes not moved yet: read `useNotesLook()`. */
export const notesLook = notesLookFor(themeFor('light'));
/** @deprecated Light only: read `useNotesLook()`. */
export const edge = notesLook.edge;
/** @deprecated Light only: read `useNotesLook()`. */
export const edgeCard = notesLook.edgeCard;
/** @deprecated Light only: read `useNotesLook()`. */
export const sectionLabel = notesLook.sectionLabel;

/** A round 36 raised button: back, search, share, ⋯. */
export function IconButton({
  icon,
  label,
  onPress,
  color,
}: {
  icon: LucideIconName;
  label: string;
  onPress: () => void;
  color?: string;
}) {
  const n = useNotesLook();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        n.raised,
        {
          width: 36,
          height: 36,
          borderRadius: 18,
          alignItems: 'center',
          justifyContent: 'center',
        },
        pressed && n.raisedPressed,
      ]}
    >
      <SystemIcon name="circle" mdName={icon} size={20} color={color ?? n.text} />
    </Pressable>
  );
}

/** Back with nothing behind goes to the Notes root, never the hidden Chat tab. */
export function goBack() {
  if (router.canGoBack()) router.back();
  else router.replace('/(tabs)/(notes)');
}

export function BackButton({ onPress }: { onPress?: () => void }) {
  const t = useNotesT();
  return <IconButton icon="ChevronLeft" label={t('back')} onPress={onPress ?? goBack} />;
}

/** A grey 36 tile with an icon in its own colour. */
export function NoteTile({
  icon,
  color,
  size = 36,
}: {
  icon: LucideIconName;
  color?: string;
  size?: number;
}) {
  const n = useNotesLook();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        backgroundColor: n.idleFill,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <SystemIcon name="circle" mdName={icon} size={20} color={color ?? n.accent} />
    </View>
  );
}

/** A teamspace's tile: its emoji, or the people icon when it has none (Figma W1, N2b). */
export function SpaceTile({ emoji }: { emoji?: string | null }) {
  const n = useNotesLook();
  if (!emoji) return <NoteTile icon="Users" />;
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: n.idleFill,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ fontSize: 18, lineHeight: 22 }}>{emoji}</Text>
    </View>
  );
}

/** The page header: an optional back, the 28 title (with ▾ when it switches), and actions. */
export function NotesHeader({
  title,
  back,
  onTitlePress,
  titleHint,
  right,
}: {
  title: string;
  back?: boolean;
  onTitlePress?: () => void;
  titleHint?: string;
  right?: React.ReactNode;
}) {
  const n = useNotesLook();
  const heading = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}>
      <Text accessibilityRole="header" numberOfLines={1} style={[n.title, { flexShrink: 1 }]}>
        {title}
      </Text>
      {onTitlePress && (
        <SystemIcon name="chevron.down" mdName="ChevronDown" size={20} color={n.secondary} />
      )}
    </View>
  );
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 4,
        minHeight: 47,
      }}
    >
      {back && <BackButton />}
      {onTitlePress ? (
        <Pressable
          cssInterop={false}
          accessibilityRole="button"
          accessibilityHint={titleHint}
          onPress={onTitlePress}
          style={({ pressed }) => ({ flex: 1, opacity: pressed ? 0.6 : 1 })}
        >
          {heading}
        </Pressable>
      ) : (
        <View style={{ flex: 1 }}>{heading}</View>
      )}
      {right}
    </View>
  );
}

export function SectionLabel({ label }: { label: string }) {
  const n = useNotesLook();
  return (
    <Text accessibilityRole="header" style={[n.sectionLabel, { lineHeight: 17 }]}>
      {label.toUpperCase()}
    </Text>
  );
}

/** A white card with the glass edge; children are rows split by inset dividers. */
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const n = useNotesLook();
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={[n.edgeCard, style]}>
      {rows.map((row, index) => (
        <React.Fragment key={index}>
          {index > 0 && <Divider />}
          {row}
        </React.Fragment>
      ))}
    </View>
  );
}

export function Divider({ inset = 14 }: { inset?: number }) {
  const n = useNotesLook();
  return <View style={{ height: 1, marginLeft: inset, backgroundColor: n.hairline }} />;
}

/** A tappable card row: tile, title (and subtitle), an optional value and a chevron. */
export function ListRow({
  icon,
  iconColor,
  title,
  subtitle,
  value,
  chevron = true,
  onPress,
  onLongPress,
  right,
  selected,
  destructive,
  accent,
  checked,
  tile,
  subtitleLines = 1,
}: {
  icon?: LucideIconName;
  /** A tile of its own in place of the icon (a teamspace's emoji). */
  tile?: React.ReactNode;
  iconColor?: string;
  /** An action row ("New folder", "Add people"): the title in the accent colour. */
  accent?: boolean;
  /** The current pick in a picker sheet: a tick on a white row (Figma N2, N8). */
  checked?: boolean;
  title: string;
  subtitle?: string;
  /** How many lines the subtitle may take before it is cut (a sentence needs two). */
  subtitleLines?: number;
  value?: string;
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  right?: React.ReactNode;
  selected?: boolean;
  destructive?: boolean;
}) {
  const n = useNotesLook();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityState={selected || checked ? { selected: true } : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={!onPress && !onLongPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingLeft: 14,
        paddingRight: 12,
        paddingVertical: 12,
        minHeight: 60,
        backgroundColor: selected ? n.selectedRow : pressed ? n.pressedRow : 'transparent',
      })}
    >
      {tile ??
        (icon && <NoteTile icon={icon} color={destructive ? n.error : (iconColor ?? n.accent)} />)}
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          numberOfLines={1}
          style={[n.rowTitle, accent && { color: n.accent }, destructive && { color: n.error }]}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={subtitleLines} style={n.rowSub}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value != null && <Text style={n.count}>{value}</Text>}
      {right}
      {(selected || checked) && (
        <SystemIcon name="checkmark" mdName="Check" size={20} color={n.accent} />
      )}
      {chevron && !selected && !checked && (
        <SystemIcon name="chevron.right" mdName="ChevronRight" size={18} color={n.tertiary} />
      )}
    </Pressable>
  );
}

/** A filter chip: white with the glass edge, brand glass with white text when selected. */
export function Chip({
  label,
  selected,
  onPress,
  icon,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  icon?: LucideIconName;
}) {
  const n = useNotesLook();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole={onPress ? 'button' : 'text'}
      accessibilityState={onPress ? { selected: Boolean(selected) } : undefined}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        {
          minHeight: 34,
          paddingHorizontal: 12,
          borderRadius: 999,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          opacity: pressed ? 0.8 : 1,
        },
        selected ? n.gloss : n.edge,
      ]}
    >
      {icon && (
        <SystemIcon
          name="circle"
          mdName={icon}
          size={14}
          color={selected ? n.onGlass : n.secondary}
        />
      )}
      <Text
        style={{
          fontSize: 14,
          lineHeight: 18,
          fontWeight: '500',
          color: selected ? n.onGlass : n.text,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The floating brand-glass "+ New", bottom right, no drop shadow. */
export function NewButton({
  onPress,
  bottom,
  label,
}: {
  onPress: () => void;
  bottom: number;
  /** Another screen's "+ Add word"; Notes says New. */
  label?: string;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  const text = label ?? t('new');
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={text}
      onPress={onPress}
      style={({ pressed }) => [
        {
          position: 'absolute',
          right: 16,
          bottom,
          height: 56,
          paddingHorizontal: 22,
          borderRadius: 999,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        },
        n.gloss,
        pressed && n.glossPressed,
      ]}
    >
      <SystemIcon name="plus" mdName="Plus" size={22} color={n.onGlass} />
      <Text style={{ color: n.onGlass, fontSize: 17, lineHeight: 24, fontWeight: '700' }}>
        {text}
      </Text>
    </Pressable>
  );
}

/** Text link in the accent colour ("Write a note", "New folder"). */
export function LinkButton({
  label,
  onPress,
  icon,
  destructive,
}: {
  label: string;
  onPress: () => void;
  icon?: LucideIconName;
  destructive?: boolean;
}) {
  const n = useNotesLook();
  const color = destructive ? n.error : n.accent;
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => ({
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      {icon && <SystemIcon name="circle" mdName={icon} size={18} color={color} />}
      <Text style={{ color, fontSize: 16, lineHeight: 22, fontWeight: '500' }}>{label}</Text>
    </Pressable>
  );
}

/**
 * A scrolling list inside a bottom sheet. A card's glass edge casts its shadow ~12 dp below and a
 * few dp above, so the list pads both ends for it and pulls the margins back in, keeping the
 * sheet's spacing: the first and last cards' shadows are never cut by the scroll view.
 */
export const sheetList = {
  style: { marginHorizontal: -16, marginTop: -6, marginBottom: -12 },
  content: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 16 },
} satisfies { style: ViewStyle; content: ViewStyle };
