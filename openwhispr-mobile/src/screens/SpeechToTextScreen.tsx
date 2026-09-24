import React, { useCallback } from 'react';
import { router } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { InferenceModePicker } from '@/components/settings/InferenceModePicker';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useAuthStore } from '@/store/useAuthStore';
import { confirmSpeechModeReady } from '@/lib/byokWorkflows';
import { dictationModeConfig } from '@/lib/inferenceModes';
import { safeHaptics } from '@/lib/utils';
import { type InferenceMode, processingToInferenceMode } from '@/types';

export default function SpeechToTextScreen() {
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const { activeMode, setActiveMode } = useProcessingModeStore();
  const user = useAuthStore((state) => state.user);

  const selectedMode: InferenceMode = processingToInferenceMode(config?.defaultMode ?? activeMode);

  const handleSelectMode = useCallback(
    async (mode: InferenceMode) => {
      if (mode === 'providers') {
        router.push({
          pathname: '/(account)/provider-workflow',
          params: { scope: 'dictation', mode: 'providers' },
        });
        return;
      }
      if (mode === selectedMode) return;
      safeHaptics('light');
      const nextMode = mode === 'local' ? 'private' : 'cloud';
      if (!(await confirmSpeechModeReady(nextMode, user))) return;

      setActiveMode(nextMode, true);
      updateConfig(dictationModeConfig(config ?? null, nextMode));
    },
    [config, selectedMode, setActiveMode, updateConfig, user],
  );

  return (
    <SettingsScreen>
      <InferenceModePicker scope="speech" selectedMode={selectedMode} onSelect={handleSelectMode} />

      <SettingsSection title="On-Device Models">
        <SettingsRow
          iconStyle="line"
          icon="arrow.down.circle"
          mdIcon="Download"
          title="Transcription Models"
          description="Download on-device models for private mode."
          onPress={() => router.push('/(account)/model-download')}
        />
        <SettingsRow
          iconStyle="line"
          icon="person.2"
          mdIcon="Users"
          title="Speaker Separation"
          description="Required for meeting transcription."
          onPress={() => router.push('/(account)/diarization-model')}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}
