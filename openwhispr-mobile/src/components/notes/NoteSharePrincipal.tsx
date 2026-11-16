import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import type { NoteAccessPrincipalType } from '@/data/remote/noteSharingTypes';

export const PRINCIPAL_LABEL: Record<NoteAccessPrincipalType, string> = {
  user: 'Person',
  email: 'Email',
  team: 'Team',
  space: 'Team space',
  folder: 'Folder',
  workspace: 'Workspace',
};

type IconPair = [sfName: string, mdName: LucideIconName];

const GROUP_ICON: Partial<Record<NoteAccessPrincipalType, IconPair>> = {
  team: ['person.2', 'Users'],
  space: ['person.3', 'Users'],
  folder: ['folder', 'Folder'],
  workspace: ['building.2', 'Building2'],
};
const MAIL_ICON: IconPair = ['envelope', 'Mail'];

interface RowIconProps {
  name: string;
  mdName: LucideIconName;
  /** Brand marks the row's current state; neutral is for everything else. */
  tone?: 'neutral' | 'brand';
}

/** The leading icon of a row in the share sheet's cards. */
export function RowIcon({ name, mdName, tone = 'neutral' }: RowIconProps) {
  const brand = tone === 'brand';
  return (
    <View
      className={`h-8 w-8 items-center justify-center rounded-full ${
        brand ? 'bg-brand/10' : 'bg-tertiarySystemFill'
      }`}
    >
      <SystemIcon
        name={name}
        mdName={mdName}
        size={15}
        color={brand ? 'brand' : 'secondaryLabel'}
      />
    </View>
  );
}

interface PrincipalAvatarProps {
  type: NoteAccessPrincipalType;
  name?: string | null;
  email?: string | null;
}

/** A person's initial, or an icon for groups and addresses without an account. */
export function PrincipalAvatar({ type, name, email }: PrincipalAvatarProps) {
  const icon = GROUP_ICON[type] ?? (type === 'email' ? MAIL_ICON : undefined);
  if (icon) return <RowIcon name={icon[0]} mdName={icon[1]} />;
  const initial = (name || email || '?').trim().charAt(0).toUpperCase();
  return (
    <View className="h-8 w-8 items-center justify-center rounded-full bg-brand/10">
      <Text className="text-[14px] font-semibold text-brand">{initial}</Text>
    </View>
  );
}
