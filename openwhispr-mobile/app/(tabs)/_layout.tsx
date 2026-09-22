import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useSegments } from 'expo-router';
import { useHandoffStore } from '@/store/useHandoffStore';

// Static routes inside the (notes) stack — anything else under (notes) is the
// dynamic [id] editor route.
const NOTES_STATIC_ROUTES = new Set(['index', 'notes', 'actions']);

// Without an explicit anchor, expo-router resolves /(tabs) to the
// alphabetically-first child — (dictionary). Anchor it to the Record/home tab so
// navigating to the group lands on home.
export const unstable_settings = {
  initialRouteName: '(record)',
};

export default function TabsLayout() {
  const segments = useSegments() as string[];
  const isNoteEditor =
    segments[1] === '(notes)' && segments[2] !== undefined && !NOTES_STATIC_ROUTES.has(segments[2]);
  // The keyboard-dictation handoff takes over the Record tab with a full-screen
  // "Swipe back to your app" prompt — hide the tab bar so it reads as a takeover.
  const handoffActive = useHandoffStore((s) => s.isActive);

  return (
    <NativeTabs minimizeBehavior="onScrollDown" hidden={isNoteEditor || handoffActive}>
      <NativeTabs.Trigger name="(record)">
        <NativeTabs.Trigger.Label>Record</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="mic.fill" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(notes)">
        <NativeTabs.Trigger.Label>Notes</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="note.text" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(dictionary)">
        <NativeTabs.Trigger.Label>Dictionary</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="text.book.closed.fill" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(referral)">
        <NativeTabs.Trigger.Label>Referral</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="gift.fill" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
