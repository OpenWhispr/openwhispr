import React, { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { SoonBadge } from '@/components/ui/SoonBadge';
import { useConfigToggle } from '@/hooks/useConfigToggle';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { MODE_LABELS } from '@/lib/inferenceModes';
import { getLocalReasoningReadiness } from '@/lib/localReasoning';
import {
  processingToInferenceMode,
  type InferenceMode,
  type LocalReasoningReadiness,
} from '@/types';

function localReasoningStatusLabel(readiness: LocalReasoningReadiness | null): string {
  switch (readiness?.status) {
    case 'ready':
      return 'Ready';
    case 'disabled':
      return 'Disabled';
    case 'appleIntelligenceOff':
      return 'Apple Intelligence off';
    case 'modelNotReady':
      return 'Model not ready';
    case 'unavailable':
      return 'Not eligible';
    default:
      return 'Checking...';
  }
}

export default function AIModelsScreen() {
  const config = useConfigStore((state) => state.config);
  const { activeMode } = useProcessingModeStore();
  const [localReadiness, setLocalReadiness] = useState<LocalReasoningReadiness | null>(null);
  const localIntelligenceEnabled = config?.appleLocalIntelligenceEnabled ?? true;
  const handleToggleLocalIntelligence = useConfigToggle('appleLocalIntelligenceEnabled');

  const currentMode: InferenceMode = processingToInferenceMode(config?.defaultMode ?? activeMode);

  useEffect(() => {
    let cancelled = false;
    if (!localIntelligenceEnabled) {
      setLocalReadiness({ status: 'disabled', tokenCounting: false });
      return () => {
        cancelled = true;
      };
    }
    getLocalReasoningReadiness({ refresh: true }).then((readiness) => {
      if (!cancelled) setLocalReadiness(readiness);
    });
    return () => {
      cancelled = true;
    };
  }, [localIntelligenceEnabled]);

  return (
    <SettingsScreen>
      <SettingsSection title="Transcription">
        <SettingsRow
          iconStyle="line"
          icon="waveform"
          mdIcon="AudioLines"
          title="Speech to Text"
          subtitle={MODE_LABELS[currentMode]}
          onPress={() => router.push('/(account)/speech-to-text')}
        />
      </SettingsSection>

      <SettingsSection title="LLM Intelligence">
        <SettingsRow
          iconStyle="line"
          icon="sparkles"
          mdIcon="Sparkles"
          title="Dictation Cleanup"
          onPress={() => router.push('/(account)/dictation-cleanup')}
        />
        <SettingsRow
          iconStyle="line"
          icon="doc.text"
          mdIcon="FileText"
          title="Note Formatting"
          onPress={() => router.push('/(account)/note-formatting')}
        />
        <SettingsRow
          iconStyle="line"
          icon="bubble.left.and.bubble.right"
          mdIcon="MessagesSquare"
          title="Chat Intelligence"
          rightElement={<SoonBadge />}
          showChevron={false}
        />
        <SettingsRow
          iconStyle="line"
          icon="sparkles"
          mdIcon="Sparkles"
          title="Local Apple Intelligence"
          description={`Status: ${localReasoningStatusLabel(localReadiness)}. Use Apple Intelligence for private and signed-out note generation when available.`}
          rightElement={
            <SettingsSwitch
              value={localIntelligenceEnabled}
              onValueChange={handleToggleLocalIntelligence}
            />
          }
          showChevron={false}
        />
      </SettingsSection>
    </SettingsScreen>
  );
}
