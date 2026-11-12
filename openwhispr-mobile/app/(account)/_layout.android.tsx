import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { WorkflowSettingsHeader } from '@/components/settings/WorkflowSettingsHeader.android';
import { Stack, router } from 'expo-router';
import { Pressable } from 'react-native';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { safeHaptics } from '@/lib/utils';
import { customHeaderStackOptions, glassStackOptions } from '@/config/navigation';
import { WORKFLOW_LABELS, parseWorkflow } from '@/lib/aiWorkflows';

const androidPageHeader = customHeaderStackOptions;

// Preserve the native back action for routes that use the standard header.
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

function renderWorkflowHeader({ options, navigation }: NativeStackHeaderProps) {
  return <WorkflowSettingsHeader title={options.title ?? ''} onBack={navigation.goBack} />;
}

export default function AccountLayout() {
  const { copy } = useAndroidCopy();
  return (
    <Stack
      screenOptions={{
        ...glassStackOptions,
        headerBackVisible: false,
        headerLeft: renderHeaderLeft,
      }}
    >
      <Stack.Screen name="device-check" options={customHeaderStackOptions} />
      <Stack.Screen name="help" options={customHeaderStackOptions} />
      <Stack.Screen name="index" options={customHeaderStackOptions} />
      <Stack.Screen name="profile" options={{ title: 'Profile', headerLargeTitle: false }} />
      <Stack.Screen
        name="referral"
        options={{ title: 'Referral', headerLargeTitle: false, ...androidPageHeader }}
      />
      <Stack.Screen
        name="ai-models"
        options={{ title: 'AI Models', headerLargeTitle: false, ...androidPageHeader }}
      />
      <Stack.Screen
        name="ai-workflow"
        options={({ route }) => {
          const scope = parseWorkflow((route.params as { scope?: string })?.scope);
          return {
            title: scope ? copy(`workflowSettings.${scope}`, WORKFLOW_LABELS[scope]) : '',
            headerLargeTitle: false,
            header: renderWorkflowHeader,
          };
        }}
      />
      <Stack.Screen
        name="dictation-agent"
        options={{ title: 'Voice Assistant', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="keyboard-tone"
        options={{ title: 'Keyboard Tone', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="hardware-keyboard"
        options={{ title: 'Hardware Keyboard', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="cleanup-prompt"
        options={{ title: 'Cleanup Prompt', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="preferences"
        options={{ title: 'Preferences', headerLargeTitle: false, ...androidPageHeader }}
      />
      <Stack.Screen
        name="google-calendar"
        options={{ title: 'Google Calendar', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="transcription-language"
        options={{ title: 'Transcription Language', headerLargeTitle: false }}
      />
      <Stack.Screen
        name="privacy"
        options={{ title: 'Privacy & Data', headerLargeTitle: false, ...androidPageHeader }}
      />
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
        options={{ title: 'Licenses & Attribution', headerLargeTitle: false, ...androidPageHeader }}
      />
    </Stack>
  );
}
