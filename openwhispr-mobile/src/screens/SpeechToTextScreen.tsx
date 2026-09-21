import React, { useCallback } from 'react';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { InferenceModePicker } from '@/components/settings/InferenceModePicker';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { useAuthStore } from '@/store/useAuthStore';
import { accountRequiredForCloud, showAccountRequiredAlert } from '@/lib/accountAccess';
import { getPrivateModeReadiness, getPrivateModeUnavailableMessage } from '@/lib/privateMode';
import { safeHaptics } from '@/lib/utils';
import { type InferenceMode, inferenceToProcessingMode, processingToInferenceMode } from '@/types';

export default function SpeechToTextScreen() {
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const { activeMode, setActiveMode } = useProcessingModeStore();
  const user = useAuthStore((state) => state.user);

  const selectedMode: InferenceMode = processingToInferenceMode(config?.defaultMode ?? activeMode);

  const handleSelectMode = useCallback(
    async (mode: InferenceMode) => {
      if (mode === selectedMode) return;
      safeHaptics('light');
      const nextProcessing = inferenceToProcessingMode(mode);

      if (nextProcessing === 'cloud' && accountRequiredForCloud(user)) {
        showAccountRequiredAlert('cloud transcription');
        return;
      }

      if (nextProcessing === 'private') {
        const readiness = await getPrivateModeReadiness().catch(() => null);
        if (!readiness) {
          Alert.alert('On-Device Unavailable', 'Unable to check the local model right now.');
          return;
        }
        if (readiness.status === 'unavailable') {
          Alert.alert('On-Device Unavailable', getPrivateModeUnavailableMessage());
          return;
        }
        if (readiness.status === 'missing') {
          Alert.alert(
            'Download required',
            `Download the on-device model (${readiness.modelName}) before switching to on-device.`,
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Download', onPress: () => router.push('/(account)/model-download') },
            ],
          );
          return;
        }
      }

      setActiveMode(nextProcessing, true);
      updateConfig({ defaultMode: nextProcessing });
    },
    [selectedMode, setActiveMode, updateConfig, user],
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
