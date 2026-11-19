import React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { gloss, glossPressed, home } from '../home/kit';
import { edge, edgeCard, look, sectionLabel } from '../settings/look';
import { useNotesT } from './strings';

/**
 * Notes in OpenWhispr's design language (Figma "section · R · Fable reskin of Notes"): the
 * Settings reskin's glass edge, grey 36 tiles and section labels, on the canvas colour.
 */
export const notesLook = {
  ...look,
  canvas: look.canvas,
  text: home.text,
  secondary: home.secondary,
  tertiary: home.tertiary,
  accent: home.accent,
  title: { fontSize: 28, lineHeight: 39, fontWeight: '500' as const, color: home.text },
  rowTitle: { fontSize: 17, lineHeight: 24, fontWeight: '500' as const, color: home.text },
  rowSub: { fontSize: 13, lineHeight: 18, color: home.secondary },
  rowMeta: { fontSize: 12, lineHeight: 16, color: home.tertiary },
  count: { fontSize: 15, lineHeight: 21, color: home.secondary },
  selectedRow: 'rgba(21,75,212,0.08)',
};

export { edge, edgeCard, sectionLabel };

/** A round 36 button with the glass edge: back, search, share, ⋯. */
export function IconButton({
  icon,
  label,
  onPress,
  color = home.text,
}: {
  icon: LucideIconName;
  label: string;
  onPress: () => void;
  color?: string;
}) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => ({
        ...edge,
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <SystemIcon name="circle" mdName={icon} size={20} color={color} />
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
  return (
    <IconButton
      icon="ChevronLeft"
      label={t('back')}
      onPress={onPress ?? goBack}
      color={home.accent}
    />
  );
}

/** A grey 36 tile with an icon in its own colour. */
export function NoteTile({
  icon,
  color = home.accent,
  size = 36,
}: {
  icon: LucideIconName;
  color?: string;
  size?: number;
}) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: 10,
        backgroundColor: look.idleFill,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <SystemIcon name="circle" mdName={icon} size={20} color={color} />
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
  const heading = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}>
      <Text
        accessibilityRole="header"
        numberOfLines={1}
        style={[notesLook.title, { flexShrink: 1 }]}
      >
        {title}
      </Text>
      {onTitlePress && (
        <SystemIcon name="chevron.down" mdName="ChevronDown" size={20} color={home.secondary} />
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
  return (
    <Text accessibilityRole="header" style={[sectionLabel, { lineHeight: 17 }]}>
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
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={[edgeCard, style]}>
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
  return <View style={{ height: 1, marginLeft: inset, backgroundColor: look.hairline }} />;
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
}: {
  icon?: LucideIconName;
  iconColor?: string;
  title: string;
  subtitle?: string;
  value?: string;
  chevron?: boolean;
  onPress?: () => void;
  onLongPress?: () => void;
  right?: React.ReactNode;
  selected?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityState={selected ? { selected } : undefined}
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
        backgroundColor: selected
          ? notesLook.selectedRow
          : pressed
            ? 'rgba(0,0,0,0.04)'
            : 'transparent',
      })}
    >
      {icon && (
        <NoteTile icon={icon} color={destructive ? look.error : (iconColor ?? home.accent)} />
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={[notesLook.rowTitle, destructive && { color: look.error }]}>
          {title}
        </Text>
        {subtitle ? (
          <Text numberOfLines={1} style={notesLook.rowSub}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {value != null && <Text style={notesLook.count}>{value}</Text>}
      {right}
      {selected && <SystemIcon name="checkmark" mdName="Check" size={20} color={home.accent} />}
      {chevron && !selected && (
        <SystemIcon name="chevron.right" mdName="ChevronRight" size={18} color={home.tertiary} />
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
        selected ? gloss : edge,
      ]}
    >
      {icon && (
        <SystemIcon
          name="circle"
          mdName={icon}
          size={14}
          color={selected ? '#FFFFFF' : home.secondary}
        />
      )}
      <Text
        style={{
          fontSize: 14,
          lineHeight: 18,
          fontWeight: '500',
          color: selected ? '#FFFFFF' : home.text,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/** The floating brand-glass "+ New", bottom right, no drop shadow. */
export function NewButton({ onPress, bottom }: { onPress: () => void; bottom: number }) {
  const t = useNotesT();
  return (
    <Pressable
      cssInterop={false}
      accessibilityRole="button"
      accessibilityLabel={t('new')}
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
        gloss,
        pressed && glossPressed,
      ]}
    >
      <SystemIcon name="plus" mdName="Plus" size={22} color="#FFFFFF" />
      <Text style={{ color: '#FFFFFF', fontSize: 17, lineHeight: 24, fontWeight: '700' }}>
        {t('new')}
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
  const color = destructive ? look.error : home.accent;
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
