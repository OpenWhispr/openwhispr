// Android's section header: the shared one's layout, coloured from the theme at render.
import { useEffect } from 'react';
import { View, Pressable } from 'react-native';
import { Text } from '@/components/ui/Text';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/android/shared/lib/utils';
import { useTheme } from '@/android/ThemeProvider';

type SectionHeaderProps = {
  label: string;
  collapsible?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
};

export function SectionHeader({
  label,
  collapsible = false,
  expanded = true,
  onToggle,
}: SectionHeaderProps) {
  const { tokens: t } = useTheme();
  const rotation = useSharedValue(expanded ? 0 : -90);

  useEffect(() => {
    rotation.value = withTiming(expanded ? 0 : -90, { duration: 180 });
  }, [expanded, rotation]);

  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value}deg` }],
  }));

  const Content = (
    <View className="flex-row items-center justify-between px-4 pb-1.5 pt-7">
      <Text className="text-[13px] uppercase tracking-wider" style={{ color: t.secondary }}>
        {label}
      </Text>
      {collapsible && (
        <Animated.View style={chevronStyle}>
          <SystemIcon name="chevron.down" mdName="ChevronDown" size={12} color={t.secondary} />
        </Animated.View>
      )}
    </View>
  );

  if (!collapsible) return Content;

  return (
    <Pressable
      onPress={() => {
        safeHaptics('selection');
        onToggle?.();
      }}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={label}
    >
      {Content}
    </Pressable>
  );
}
