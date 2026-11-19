import { Pressable, ScrollView, View } from 'react-native';
import { Text } from './Text';

/**
 * Android's one tab style (Dictionary's Words | Snippets): a round grey track, the picked tab a
 * round white pill with the glass edge, 16 Medium labels, and an optional grey count. Notes,
 * the recorder, Style and Dictionary all use this, so every screen's tabs look the same.
 */
const TRACK = '#E8E7E4';
const TEXT = '#181714';
const SECONDARY = '#6E6D69';
const TERTIARY = '#A8A7A3';
const PICKED = {
  backgroundColor: '#FFFFFF',
  borderWidth: 1,
  borderColor: 'rgba(0,0,0,0.06)',
  boxShadow: 'inset 0px 1px 0px rgba(255,255,255,0.7), 0px 2px 10px rgba(15,23,42,0.06)',
} as const;

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Shown beside the label in grey ("Words 42"). */
  count?: number;
  /** A small orange dot after the label (a summary that's out of date). */
  dot?: boolean;
  testID?: string;
};

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  scrollable = false,
  disabled = false,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  scrollable?: boolean;
  disabled?: boolean;
}) {
  const segments = (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: 'row', borderRadius: 999, padding: 3, backgroundColor: TRACK }}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            cssInterop={false}
            key={option.value}
            testID={option.testID}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={
              option.count != null ? `${option.label}, ${option.count}` : option.label
            }
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              {
                flex: scrollable ? undefined : 1,
                minHeight: 38,
                paddingHorizontal: 16,
                borderRadius: 999,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                opacity: pressed ? 0.7 : 1,
              },
              selected && PICKED,
            ]}
          >
            <Text
              numberOfLines={1}
              style={{
                fontSize: 16,
                lineHeight: 21,
                fontWeight: '500',
                color: selected ? TEXT : SECONDARY,
              }}
            >
              {option.label}
            </Text>
            {option.count != null ? (
              <Text style={{ fontSize: 16, lineHeight: 21, color: TERTIARY }}>{option.count}</Text>
            ) : null}
            {option.dot ? (
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#FF9500' }} />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
  return scrollable ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      // The picked pill's shadow needs room above and below.
      contentContainerStyle={{ paddingVertical: 4 }}
    >
      {segments}
    </ScrollView>
  ) : (
    segments
  );
}
