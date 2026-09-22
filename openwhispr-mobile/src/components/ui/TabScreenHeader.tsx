import { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GLASS_CAPSULE_SIZE } from '@/components/ui/GlassIconButton';

type Props = {
  title: string;
  left?: ReactNode;
  right?: ReactNode;
};

// The title is centred across the whole row rather than laid out between the
// buttons, so it has to be inset by at least their width — otherwise a long
// title runs underneath them instead of truncating. One gutter per side keeps
// the text optically centred whether or not `right` is supplied.
const TITLE_GUTTER = GLASS_CAPSULE_SIZE + 12;

export function TabScreenHeader({ title, left, right }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View className="px-4" style={{ paddingTop: insets.top + 8 }}>
      <View className="min-h-[44px] flex-row items-center justify-between">
        <View>{left}</View>
        <View pointerEvents="none" testID="screen-header-title" style={styles.titleWrap}>
          <Text numberOfLines={1} className="text-[17px] font-semibold text-label">
            {title}
          </Text>
        </View>
        <View>{right}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  titleWrap: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: TITLE_GUTTER,
    right: TITLE_GUTTER,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
