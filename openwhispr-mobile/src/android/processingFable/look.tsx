import { Pressable, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { gloss, glossPressed, home, type } from '../home/kit';
import type { SheetTask } from '../settings/ownKey';
import type { Place, Source } from './places';
import { PROVIDER_LOGOS } from './providerLogos';
import { look as settingsLook } from '../settings/look';
import { raised, raisedPressed, theme } from '../theme';

/**
 * Processing in OpenWhispr's design language (Figma sections 8 and 9): the desktop's glass edge
 * on cards and fields, the Home's glossy tile for the place in use, desktop provider logos.
 * The shared values live in `settings/look.ts`, so Settings and Processing stay one look.
 */
export const look = { ...settingsLook, pickedRow: 'rgba(21,85,212,0.08)' };

export { edgeCard, sectionLabel } from '../settings/look';

export const PLACE_ICON: Record<Place, LucideIconName> = {
  cloud: 'Cloud',
  device: 'Smartphone',
  key: 'Key',
};

export const TASK_ICON: Record<SheetTask, LucideIconName> = {
  dictation: 'Mic',
  upload: 'FileUp',
  cleanup: 'Sparkles',
  notes: 'NotepadText',
  agent: 'Sparkle',
  meeting: 'Users',
};

type TileKind = 'glass' | 'idle' | 'sel' | 'logo';

/** A 36 px rounded tile: glossy blue (in use), grey (idle), blue tint (picked) or white (logo). */
export function Tile({
  kind,
  icon,
  source,
  size = 36,
}: {
  kind: TileKind;
  icon?: LucideIconName;
  source?: Source;
  size?: number;
}) {
  const logo = source && source !== 'custom' ? PROVIDER_LOGOS[source] : null;
  const color = kind === 'glass' ? theme.onGlass : kind === 'sel' ? home.accent : home.text;
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
        },
        kind === 'glass' && gloss,
        kind === 'idle' && { backgroundColor: look.idleFill },
        kind === 'sel' && { backgroundColor: look.selFill },
        kind === 'logo' && {
          backgroundColor: home.surface,
          borderWidth: 1,
          borderColor: theme.divider,
        },
      ]}
    >
      {logo ? (
        <SvgXml xml={logo} width={20} height={20} />
      ) : (
        <SystemIcon
          name="circle"
          mdName={source === 'custom' ? 'Link' : (icon ?? 'Circle')}
          size={20}
          color={color}
        />
      )}
    </View>
  );
}

/** A provider's mark on its own, for the Provider field (18) and the model list label (14). */
export function ProviderMark({ source, size }: { source: Source; size: number }) {
  if (source === 'custom')
    return <SystemIcon name="link" mdName="Link" size={size} color={home.secondary} />;
  return <SvgXml xml={PROVIDER_LOGOS[source]} width={size} height={size} />;
}

/** The small square tag: Live (blue) or After (grey), and "N tasks" beside a place's name. */
export function Tag({ label, neutral }: { label: string; neutral?: boolean }) {
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 6,
        backgroundColor: neutral ? look.track : look.selFill,
      }}
    >
      <Text
        style={{
          fontSize: 11,
          lineHeight: 15,
          fontWeight: '500',
          color: neutral ? home.secondary : home.accent,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function CountBadge({ label }: { label: string }) {
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 6,
        backgroundColor: look.selFill,
      }}
    >
      <Text style={{ fontSize: 12, lineHeight: 16, fontWeight: '500', color: home.accent }}>
        {label}
      </Text>
    </View>
  );
}

/** The raised white button inside a card ("Use for everything", "+ Add a key"). */
export function OutlineButton({
  label,
  icon,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  icon?: LucideIconName;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      cssInterop={false}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        raised,
        {
          minHeight: 44,
          paddingVertical: 10,
          borderRadius: 999,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          opacity: disabled ? 0.5 : 1,
        },
        pressed && !disabled && raisedPressed,
      ]}
    >
      {icon && <SystemIcon name="plus" mdName={icon} size={18} color={home.text} />}
      <Text style={[type.subhead, { fontWeight: '500' }]}>{label}</Text>
    </Pressable>
  );
}

/** The primary CTA: flat brand glass with its inner highlight, no lift. Disabled at 50%. */
export function GlassButton({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      cssInterop={false}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        {
          minHeight: 48,
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: 16,
          opacity: disabled ? 0.5 : 1,
        },
        gloss,
        pressed && !disabled && glossPressed,
      ]}
    >
      <Text style={[type.subhead, { color: theme.onGlass, fontWeight: '500' }]}>{label}</Text>
    </Pressable>
  );
}
