import { View } from 'react-native';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { createSpaceRow } from './SpaceRowCore';

export const SpaceRow = createSpaceRow(function useSpaceRowPresentation(count) {
  const { copy } = useAndroidCopy();
  return {
    memberLabel: copy('library.memberCount', `${count} ${count === 1 ? 'member' : 'members'}`, {
      count,
    }),
    nameLines: 2,
    renderContent: (name, members, chevron) => (
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 gap-1">
          {name}
          {members}
        </View>
        {chevron}
      </View>
    ),
  };
});
