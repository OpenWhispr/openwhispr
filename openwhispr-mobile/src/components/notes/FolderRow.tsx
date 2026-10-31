import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { Platform, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { GroupedList } from './GroupedList';
import { SystemIcon } from '@/components/ui/SystemIcon';
import type { LucideIconName } from '@/components/ui/SystemIcon';

type FolderRowProps = {
  sfName: string;
  mdName: LucideIconName;
  label: string;
  count: number;
  iconColor?: string;
  onPress: () => void;
  onLongPress?: () => void;
};

export function FolderRow({
  sfName,
  mdName,
  label,
  count,
  iconColor = 'brand',
  onPress,
  onLongPress,
}: FolderRowProps) {
  const { copy } = useAndroidCopy();
  const countLabel = copy('library.noteCount', `${count} ${count === 1 ? 'note' : 'notes'}`, {
    count,
  });
  return (
    <GroupedList.Row
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${countLabel}`}
      leadingIconSlot={<SystemIcon name={sfName} mdName={mdName} size={22} color={iconColor} />}
    >
      <View
        className={
          Platform.OS === 'android'
            ? 'flex-row items-center justify-between gap-3'
            : 'flex-row items-center justify-between'
        }
      >
        <Text
          className={
            Platform.OS === 'android'
              ? 'min-w-0 flex-1 text-[17px] font-medium text-label'
              : 'text-[17px] font-medium text-label'
          }
          numberOfLines={Platform.OS === 'android' ? 2 : 1}
        >
          {label}
        </Text>
        <View className="flex-row items-center gap-2">
          <Text
            className="text-[15px] text-tertiaryLabel"
            style={{ fontVariant: ['tabular-nums'] }}
          >
            {count}
          </Text>
          <SystemIcon
            name="chevron.right"
            mdName="ChevronRight"
            size={13}
            color="quaternaryLabel"
          />
        </View>
      </View>
    </GroupedList.Row>
  );
}
