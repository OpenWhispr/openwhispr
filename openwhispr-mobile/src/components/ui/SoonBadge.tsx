import React from 'react';
import { View } from 'react-native';
import { Text } from '@/components/ui/Text';

export function SoonBadge() {
  return (
    <View
      style={{ borderCurve: 'continuous' }}
      className="rounded-full bg-tertiarySystemFill px-2 py-0.5"
    >
      <Text className="text-[11px] font-semibold uppercase tracking-wider text-secondaryLabel">
        Soon
      </Text>
    </View>
  );
}
