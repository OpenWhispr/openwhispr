import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useSegments } from 'expo-router';
import { useHandoffStore } from '@/store/useHandoffStore';
import { AppFont } from '@/lib/fonts';
import { isTabBarHidden } from '@/components/ui/tabBarClearance';

// Without an explicit anchor, expo-router resolves /(tabs) to the
// alphabetically-first child — (dictionary). Anchor it to the Record/home tab so
// navigating to the group lands on home.
export const unstable_settings = {
  initialRouteName: '(record)',
};

export default function TabsLayout() {
  const segments = useSegments() as string[];
  // The keyboard-dictation handoff takes over the Record tab with a full-screen
  // return screen ("Returning to your app…", "Back to <App>", or the swipe
  // instructions) — hide the tab bar so it reads as a takeover.
  const handoffActive = useHandoffStore((s) => s.isActive);

  return (
    <NativeTabs
      minimizeBehavior="onScrollDown"
      hidden={isTabBarHidden(segments, handoffActive)}
      labelStyle={{ fontFamily: AppFont.medium }}
    >
      <NativeTabs.Trigger name="(record)">
        <NativeTabs.Trigger.Label>Record</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="mic.fill" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(notes)">
        <NativeTabs.Trigger.Label>Notes</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="note.text" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(chat)">
        <NativeTabs.Trigger.Label>Chat</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right.fill" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(dictionary)">
        <NativeTabs.Trigger.Label>Dictionary</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="text.book.closed.fill" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
