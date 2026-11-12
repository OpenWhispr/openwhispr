import { Pressable, ScrollView, View } from 'react-native';
import { Text } from './Text';
import { iosColor } from '@/config/colors';

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  scrollable = false,
  disabled = false,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  scrollable?: boolean;
  disabled?: boolean;
}) {
  const segments = (
    <View
      style={{
        flexDirection: 'row',
        borderRadius: 12,
        padding: 3,
        backgroundColor: iosColor('tertiarySystemFill'),
      }}
    >
      {options.map((option) => (
        <Pressable
          cssInterop={false}
          key={option.value}
          accessibilityRole="tab"
          accessibilityState={{ selected: option.value === value, disabled }}
          disabled={disabled}
          onPress={() => onChange(option.value)}
          style={({ pressed }) => ({
            flex: scrollable ? undefined : 1,
            minHeight: 48,
            paddingHorizontal: 14,
            paddingVertical: 10,
            borderRadius: 9,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor:
              option.value === value ? iosColor('secondarySystemGroupedBackground') : 'transparent',
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Text
            style={{
              fontSize: 14,
              fontWeight: '500',
              textAlign: 'center',
              color: iosColor(option.value === value ? 'label' : 'secondaryLabel'),
            }}
          >
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
  return scrollable ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {segments}
    </ScrollView>
  ) : (
    segments
  );
}
