import { Pressable, View } from 'react-native';
import { SvgXml } from 'react-native-svg';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { useHome } from '../home/kit';
import type { SheetTask } from '../settings/ownKey';
import type { Place, Source } from './places';
import { PROVIDER_LOGOS } from './providerLogos';
import { settingsLookFor } from '../settings/look';
import { themeFor, useTheme, type AndroidTheme } from '../ThemeProvider';
import type { Scheme } from '../theme';

/**
 * Processing in OpenWhispr's design language (Figma sections 8 and 9): the desktop's glass edge
 * on cards and fields, the Home's glossy tile for the place in use, desktop provider logos.
 * The shared values live in `settings/look.ts`, so Settings and Processing stay one look.
 */
function buildProcessingLook(theme: AndroidTheme) {
  return {
    ...settingsLookFor(theme).look,
    pickedRow: theme.scheme === 'dark' ? 'rgba(110,155,255,0.14)' : 'rgba(21,85,212,0.08)',
    /**
     * The plate behind a provider's logo: the surface in light, a light plate in dark so black
     * marks (OpenAI, Mistral) stay visible (design §3.6).
     */
    logoPlate: theme.scheme === 'dark' ? '#F2F2F5' : theme.tokens.surface,
  };
}
export type ProcessingLook = ReturnType<typeof buildProcessingLook>;
const looks: Partial<Record<Scheme, ProcessingLook>> = {};
export function processingLookFor(theme: AndroidTheme): ProcessingLook {
  return (looks[theme.scheme] ??= buildProcessingLook(theme));
}
/** Processing's look for the scheme in use. Read it at render; a switch re-renders in place. */
export function useProcessingLook(): ProcessingLook {
  return processingLookFor(useTheme());
}
/** @deprecated Light only: read `useProcessingLook()`. */
export const look = processingLookFor(themeFor('light'));

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
  const th = useTheme();
  const look = useProcessingLook();
  const home = useHome().c;
  const logo = source && source !== 'custom' ? PROVIDER_LOGOS[source] : null;
  const color = kind === 'glass' ? th.tokens.onGlass : kind === 'sel' ? home.accent : home.text;
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
        kind === 'glass' && th.glass,
        kind === 'idle' && { backgroundColor: look.idleFill },
        kind === 'sel' && { backgroundColor: look.selFill },
        kind === 'logo' && {
          backgroundColor: look.logoPlate,
          borderWidth: 1,
          borderColor: th.tokens.divider,
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
  const th = useTheme();
  const look = useProcessingLook();
  if (source === 'custom')
    return <SystemIcon name="link" mdName="Link" size={size} color={th.tokens.secondary} />;
  const mark = <SvgXml xml={PROVIDER_LOGOS[source]} width={size} height={size} />;
  if (th.scheme !== 'dark') return mark;
  // In dark the mark sits on a small light plate, so black logos don't vanish.
  return (
    <View
      style={{
        width: size + 6,
        height: size + 6,
        borderRadius: (size + 6) / 4,
        backgroundColor: look.logoPlate,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {mark}
    </View>
  );
}

/** The small square tag: Live (blue) or After (grey), and "N tasks" beside a place's name. */
export function Tag({ label, neutral }: { label: string; neutral?: boolean }) {
  const look = useProcessingLook();
  const home = useHome().c;
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
  const look = useProcessingLook();
  const home = useHome().c;
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
  const th = useTheme();
  const h = useHome();
  return (
    <Pressable
      cssInterop={false}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        th.raised,
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
        pressed && !disabled && th.raisedPressed,
      ]}
    >
      {icon && <SystemIcon name="plus" mdName={icon} size={18} color={h.c.text} />}
      <Text style={[h.type.subhead, { fontWeight: '500' }]}>{label}</Text>
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
  const th = useTheme();
  const h = useHome();
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
        th.glass,
        pressed && !disabled && th.glassPressed,
      ]}
    >
      <Text style={[h.type.subhead, { color: th.tokens.onGlass, fontWeight: '500' }]}>{label}</Text>
    </Pressable>
  );
}
