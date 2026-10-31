import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { Platform, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { GroupedList } from './GroupedList';
import { SystemIcon } from '@/components/ui/SystemIcon';
import type { Space } from '@/data';

type SpaceRowProps = {
  space: Space;
  onPress: () => void;
};

export function SpaceRow({ space, onPress }: SpaceRowProps) {
  const { copy } = useAndroidCopy();
  const memberCount = space.memberCount ?? 0;
  const memberLabel = copy(
    'library.memberCount',
    `${memberCount} ${memberCount === 1 ? 'member' : 'members'}`,
    { count: memberCount },
  );

  return (
    <GroupedList.Row
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${space.name}, ${memberLabel}`}
      leadingIconSlot={
        space.emoji ? (
          <Text className="text-[22px]">{space.emoji}</Text>
        ) : (
          <SystemIcon name="person.2.fill" mdName="Users" size={22} color="brand" />
        )
      }
    >
      {Platform.OS === 'android' ? (
        <View className="flex-row items-center gap-3">
          <View className="min-w-0 flex-1 gap-1">
            <Text className="text-[17px] font-medium text-label" numberOfLines={2}>
              {space.name}
            </Text>
            <Text className="text-[15px] text-tertiaryLabel">{memberLabel}</Text>
          </View>
          <SystemIcon
            name="chevron.right"
            mdName="ChevronRight"
            size={13}
            color="quaternaryLabel"
          />
        </View>
      ) : (
        <View className="flex-row items-center justify-between">
          <Text className="text-[17px] font-medium text-label" numberOfLines={1}>
            {space.name}
          </Text>
          <View className="flex-row items-center gap-2">
            <Text className="text-[15px] text-tertiaryLabel">{memberLabel}</Text>
            <SystemIcon
              name="chevron.right"
              mdName="ChevronRight"
              size={13}
              color="quaternaryLabel"
            />
          </View>
        </View>
      )}
    </GroupedList.Row>
  );
}
