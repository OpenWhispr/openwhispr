import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { GroupedList } from './GroupedList';
import { SystemIcon } from '@/components/ui/SystemIcon';
import type { Space } from '@/data';

type SpaceRowProps = {
  space: Space;
  onPress: () => void;
};

type SpacePresentation = {
  memberLabel: string;
  nameLines?: number;
  renderContent?: (name: ReactNode, members: ReactNode, chevron: ReactNode) => ReactNode;
};

export function createSpaceRow(
  usePresentation: (count: number) => SpacePresentation = (count) => ({
    memberLabel: `${count} ${count === 1 ? 'member' : 'members'}`,
  }),
) {
  return function SpaceRow({ space, onPress }: SpaceRowProps) {
    const presentation = usePresentation(space.memberCount ?? 0);
    const name = (
      <Text
        className="text-[17px] font-medium text-label"
        numberOfLines={presentation.nameLines ?? 1}
      >
        {space.name}
      </Text>
    );
    const members = (
      <Text className="text-[15px] text-tertiaryLabel">{presentation.memberLabel}</Text>
    );
    const chevron = (
      <SystemIcon name="chevron.right" mdName="ChevronRight" size={13} color="quaternaryLabel" />
    );
    return (
      <GroupedList.Row
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${space.name}, ${presentation.memberLabel}`}
        leadingIconSlot={
          space.emoji ? (
            <Text className="text-[22px]">{space.emoji}</Text>
          ) : (
            <SystemIcon name="person.2.fill" mdName="Users" size={22} color="brand" />
          )
        }
      >
        {presentation.renderContent ? (
          presentation.renderContent(name, members, chevron)
        ) : (
          <View className="flex-row items-center justify-between">
            {name}
            <View className="flex-row items-center gap-2">
              {members}
              {chevron}
            </View>
          </View>
        )}
      </GroupedList.Row>
    );
  };
}
