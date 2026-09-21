import { Stack, router } from 'expo-router';
import { Pressable } from 'react-native';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/lib/utils';
import { customHeaderStackOptions, glassStackOptions } from '@/config/navigation';

// iOS 26 wraps custom header buttons in their own liquid-glass capsule, so this
// back button is a bare chevron — the native bar supplies the glass. Adding our
// own GlassBackButton here would nest a glass capsule inside the native one.
// (Custom-header screens like AccountScreen/NoteEditor use GlassBackButton
// because they render no native header to provide the glass.)
function HeaderBackButton() {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={12}
      onPress={() => {
        safeHaptics('selection');
        router.back();
      }}
      style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
    >
      <SystemIcon name="chevron.left" mdName="ChevronLeft" size={22} color="brand" />
    </Pressable>
  );
}

function renderHeaderLeft({ canGoBack }: { canGoBack?: boolean }) {
  return canGoBack ? <HeaderBackButton /> : null;
}

export default function AccountLayout() {
  return (
    <Stack
      screenOptions={{
        ...glassStackOptions,
        headerBackVisible: false,
        headerLeft: renderHeaderLeft,
      }}
    >
      <Stack.Screen name="index" options={customHeaderStackOptions} />
      <Stack.Screen name="profile" options={{ title: 'Profile', headerLargeTitle: false }} />
      <Stack.Screen name="ai-models" options={{ title: 'AI Models', headerLargeTitle: false }} />
      <Stack.Screen
        name="dictation-agent"
        options={{ title: 'Dictation Agent', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="keyboard-tone"
        options={{ title: 'Keyboard Tone', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="speech-to-text"
        options={{ title: 'Speech to Text', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="dictation-cleanup"
        options={{ title: 'Dictation Cleanup', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="cleanup-prompt"
        options={{ title: 'Cleanup Prompt', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="note-formatting"
        options={{ title: 'Note Formatting', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="preferences"
        options={{ title: 'Preferences', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="google-calendar"
        options={{ title: 'Google Calendar', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="transcription-language"
        options={{ title: 'Transcription Language', headerLargeTitle: false }}
      />
      <Stack.Screen name="privacy" options={{ title: 'Privacy & Data', headerLargeTitle: false }} />
      <Stack.Screen
        name="model-download"
        options={{ title: 'Transcription Models', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="diarization-model"
        options={{ title: 'Speaker Separation', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="parakeet-benchmark"
        options={{ title: 'Parakeet Benchmark', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="licenses"
        options={{ title: 'Licenses & Attribution', headerLargeTitle: false }}
      />
    </Stack>
  );
}
