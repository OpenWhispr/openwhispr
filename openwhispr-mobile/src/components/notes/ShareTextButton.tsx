import { Pressable } from 'react-native';
import { Text } from '@/components/ui/Text';

interface ShareTextButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
  /** Marks the current choice in a set of options; a selected option cannot be pressed again. */
  selected?: boolean;
  accessibilityLabel?: string;
}

/** A text action for the share sheet with the 44pt minimum touch height. */
export function ShareTextButton({
  label,
  onPress,
  disabled = false,
  destructive = false,
  selected,
  accessibilityLabel,
}: ShareTextButtonProps) {
  const inactive = disabled || Boolean(selected);
  const tone = selected
    ? 'font-semibold text-label'
    : disabled
      ? 'text-tertiaryLabel'
      : destructive
        ? 'text-systemRed'
        : 'text-link';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, ...(selected === undefined ? {} : { selected }) }}
      className="min-h-[44px] justify-center"
      disabled={inactive}
      onPress={onPress}
    >
      <Text className={tone}>{label}</Text>
    </Pressable>
  );
}
