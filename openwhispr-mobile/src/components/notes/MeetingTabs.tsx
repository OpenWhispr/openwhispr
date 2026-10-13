import type React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { iosColor } from '@/config/colors';
import { cn } from '@/lib/utils';

export type MeetingTab = 'notes' | 'transcript';

interface MeetingTabsProps {
  active: MeetingTab;
  onChange: (tab: MeetingTab) => void;
}

/** iOS segmented control for the cloud-recording screen: Notes / Live Transcript. */
export function MeetingTabs({ active, onChange }: MeetingTabsProps): React.JSX.Element {
  return (
    <View
      className="flex-row gap-1 rounded-[10px] p-[3px]"
      style={{ backgroundColor: 'rgba(118,118,128,0.08)', borderCurve: 'continuous' }}
    >
      <TabButton
        testID="meeting-tab-notes"
        label="Notes"
        isActive={active === 'notes'}
        onPress={() => onChange('notes')}
      />
      <TabButton
        testID="meeting-tab-transcript"
        label="Live Transcript"
        isActive={active === 'transcript'}
        onPress={() => onChange('transcript')}
        live
      />
    </View>
  );
}

function TabButton({
  testID,
  label,
  isActive,
  onPress,
  live = false,
}: {
  testID: string;
  label: string;
  isActive: boolean;
  onPress: () => void;
  live?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      onPress={onPress}
      // The className is deliberately static and the selected state lives in
      // `style`. NativeWind's `shadow-sm` sets CSS variables, and adding a
      // variable-setting class after a component's first render trips its
      // "upgrade" warning — whose message is built by JSON.stringify-ing the
      // props. That walks `children._owner` into React Navigation's context and
      // throws "Couldn't find a navigation context" from a getter, crashing on
      // every tab switch. Keep conditional styling here off NativeWind.
      className="flex-1 flex-row items-center justify-center gap-1.5 rounded-lg py-2"
      style={isActive ? styles.tabActive : styles.tab}
    >
      <Text
        className={cn('text-[14px] font-semibold', isActive ? 'text-label' : 'text-secondaryLabel')}
      >
        {label}
      </Text>
      {live ? <View className="h-1.5 w-1.5 rounded-full bg-systemRed" /> : null}
    </Pressable>
  );
}

// Mirrors Tailwind's `shadow-sm`, applied as a plain style so switching tabs
// never adds a NativeWind class after the first render. See TabButton.
const styles = StyleSheet.create({
  tab: {
    borderCurve: 'continuous',
  },
  tabActive: {
    borderCurve: 'continuous',
    backgroundColor: iosColor('secondarySystemGroupedBackground'),
    boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.05)',
  },
});
