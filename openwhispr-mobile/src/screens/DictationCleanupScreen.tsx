import React from 'react';
import { router } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { useConfigStore } from '@/store/useConfigStore';
import { useCustomPromptsStore } from '@/store/useCustomPromptsStore';
import { useConfigToggle } from '@/hooks/useConfigToggle';
import { resolveCustomPrompt } from '@/config/prompts/registry';

export default function DictationCleanupScreen() {
  const config = useConfigStore((state) => state.config);
  const cleanupEnabled = config?.cleanupEnabled ?? true;
  const handleToggleEnabled = useConfigToggle('cleanupEnabled');
  const hasCustomPrompt = useCustomPromptsStore(
    (state) => resolveCustomPrompt(state.customPrompts.cleanup) !== undefined,
  );

  return (
    <SettingsScreen>
      <SettingsSection>
        <SettingsRow
          iconStyle="line"
          icon="sparkles"
          mdIcon="Sparkles"
          title="Enable Text Cleanup"
          description="Use AI to remove filler words, fix grammar, and polish punctuation. Runs on cloud dictation only — on-device dictation returns the raw transcript."
          rightElement={
            <SettingsSwitch value={cleanupEnabled} onValueChange={handleToggleEnabled} />
          }
          showChevron={false}
        />
        <SettingsRow
          iconStyle="line"
          icon="text.quote"
          mdIcon="TextQuote"
          title="Cleanup Prompt"
          subtitle={hasCustomPrompt ? 'Custom' : 'Default'}
          onPress={() => router.push('/(account)/cleanup-prompt')}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}
