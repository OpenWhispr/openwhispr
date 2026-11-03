import { View } from 'react-native';
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

type FolderPresentation = {
  countLabel: string;
  rowClassName?: string;
  labelClassName?: string;
  labelLines?: number;
};

export function createFolderRow(
  usePresentation: (count: number) => FolderPresentation = (count) => ({
    countLabel: `${count} ${count === 1 ? 'note' : 'notes'}`,
  }),
) {
  return function FolderRow({
    sfName,
    mdName,
    label,
    count,
    iconColor = 'brand',
    onPress,
    onLongPress,
  }: FolderRowProps) {
    const presentation = usePresentation(count);
    return (
      <GroupedList.Row
        onPress={onPress}
        onLongPress={onLongPress}
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${presentation.countLabel}`}
        leadingIconSlot={<SystemIcon name={sfName} mdName={mdName} size={22} color={iconColor} />}
      >
        <View className={presentation.rowClassName ?? 'flex-row items-center justify-between'}>
          <Text
            className={presentation.labelClassName ?? 'text-[17px] font-medium text-label'}
            numberOfLines={presentation.labelLines ?? 1}
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
  };
}
