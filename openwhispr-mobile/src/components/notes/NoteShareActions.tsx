import { Fragment } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon, type LucideIconName } from '@/components/ui/SystemIcon';
import { GroupedList } from './GroupedList';

interface ShareActionRowProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
  accessibilityLabel?: string;
}

/** A tappable row that reads as an action rather than a setting. */
export function ShareActionRow({
  label,
  onPress,
  disabled = false,
  destructive = false,
  accessibilityLabel,
}: ShareActionRowProps) {
  const tone = disabled ? 'text-tertiaryLabel' : destructive ? 'text-systemRed' : 'text-link';
  return (
    <GroupedList.Row
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      <Text className={`text-[15px] ${tone}`}>{label}</Text>
    </GroupedList.Row>
  );
}

export interface ShareStripAction {
  label: string;
  accessibilityLabel?: string;
  icon: string;
  mdIcon: LucideIconName;
  onPress: () => void;
}

interface ShareActionStripProps {
  actions: ShareStripAction[];
  disabled?: boolean;
}

/** Equal-width icon buttons along the bottom of a card. */
export function ShareActionStrip({ actions, disabled = false }: ShareActionStripProps) {
  const color = disabled ? 'tertiaryLabel' : 'link';
  return (
    <View className="flex-row">
      {actions.map((action, index) => (
        <Fragment key={action.label}>
          {index > 0 && <View className="w-px bg-separator" />}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={action.onPress}
            className="min-h-[56px] flex-1 items-center justify-center gap-1 py-2 active:bg-tertiarySystemFill"
          >
            <SystemIcon name={action.icon} mdName={action.mdIcon} size={18} color={color} />
            <Text className={disabled ? 'text-[12px] text-tertiaryLabel' : 'text-[12px] text-link'}>
              {action.label}
            </Text>
          </Pressable>
        </Fragment>
      ))}
    </View>
  );
}
