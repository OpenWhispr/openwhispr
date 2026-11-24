import type { ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from './Text';
import { useTheme } from '@/android/ThemeProvider';

/**
 * Android's one tab style (Dictionary's Words | Snippets): an inset, fully round grey track, the
 * picked tab a raised white pill with an ink label, 16 Medium labels, and an optional grey count.
 * Notes, the recorder, Style and Dictionary all use this, so every screen's tabs look the same.
 * Options with an `icon` (Style's kinds of app) stack it above a 13 label in a taller tab.
 * Colours come from the theme at render, so a light/dark switch repaints the tabs in place.
 */

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Shown beside the label in grey ("Words 42"). */
  count?: number;
  /** A small orange dot after the label (a summary that's out of date). */
  dot?: boolean;
  /** Drawn above the label; told whether its tab is picked, to match the surface behind it. */
  icon?: (selected: boolean) => ReactNode;
  /** What TalkBack reads when the label is a short form ("Personal" for "Personal messages"). */
  accessibilityLabel?: string;
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
  const { tokens, inset, raised } = useTheme();
  const stacked = options.some((option) => option.icon);
  const segments = (
    <View
      accessibilityRole="tablist"
      style={[{ flexDirection: 'row', borderRadius: 999, padding: 3 }, inset]}
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
              option.accessibilityLabel ??
              (option.count != null ? `${option.label}, ${option.count}` : option.label)
            }
            disabled={disabled}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              {
                flex: scrollable ? undefined : 1,
                minHeight: stacked ? 56 : 38,
                paddingHorizontal: stacked ? 4 : 16,
                paddingVertical: stacked ? 7 : 0,
                borderRadius: 999,
                flexDirection: stacked ? 'column' : 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: stacked ? 4 : 6,
                opacity: pressed ? 0.7 : 1,
              },
              selected && raised,
            ]}
          >
            {option.icon?.(selected)}
            <Text
              numberOfLines={1}
              style={{
                fontSize: stacked ? 13 : 16,
                lineHeight: stacked ? 17 : 21,
                fontWeight: '500',
                color: selected ? tokens.ink : tokens.secondary,
              }}
            >
              {option.label}
            </Text>
            {option.count != null ? (
              <Text style={{ fontSize: 16, lineHeight: 21, color: tokens.tertiary }}>
                {option.count}
              </Text>
            ) : null}
            {option.dot ? (
              // A status dot (out of date), so the theme's warning orange.
              <View
                style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tokens.warning }}
              />
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
