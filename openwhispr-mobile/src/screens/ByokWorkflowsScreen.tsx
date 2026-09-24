import React, { useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import { clearProviderCredentials } from '@/services/providers/ProviderCredentials';
import { confirmDestructive } from '@/lib/alerts';
import { WORKFLOW_LABELS, WORKFLOWS, workflowSummary } from '@/lib/byokWorkflows';
import type { MobileInferenceScope } from '@/lib/mobileProviders';
import type { LucideIconName } from '@/components/ui/SystemIcon';

// Same symbols AI Models uses for these features.
const WORKFLOW_ICONS: Record<MobileInferenceScope, { icon: string; mdIcon: LucideIconName }> = {
  dictation: { icon: 'waveform', mdIcon: 'AudioLines' },
  upload: { icon: 'square.and.arrow.up', mdIcon: 'Upload' },
  cleanup: { icon: 'sparkles', mdIcon: 'Sparkles' },
  notes: { icon: 'doc.text', mdIcon: 'FileText' },
  agent: { icon: 'bubble.left.and.bubble.right', mdIcon: 'MessagesSquare' },
};

export function ByokWorkflowsScreen(): React.JSX.Element {
  const config = useConfigStore((state) => state.config);
  const activeMode = useProcessingModeStore((state) => state.activeMode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function removeAllCredentials(): void {
    confirmDestructive(
      'Remove all provider keys?',
      'Every provider key saved on this iPhone is deleted, including keys for Custom endpoints you no longer use. Workflows that use them stop until you add a key again.',
      async (): Promise<void> => {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
          await clearProviderCredentials();
          setNotice('All provider keys were removed.');
        } catch {
          setError('Unable to remove every provider key. Please try again.');
        } finally {
          setBusy(false);
        }
      },
      { destructiveLabel: 'Remove' },
    );
  }

  return (
    <SettingsScreen>
      <Text className="mb-4 px-8 text-[13px] text-secondaryLabel">
        Each workflow picks its own mode. Your provider bills usage.
      </Text>
      <SettingsSection title="Workflows">
        {WORKFLOWS.map((scope) => (
          <SettingsRow
            key={scope}
            iconStyle="line"
            {...WORKFLOW_ICONS[scope]}
            title={WORKFLOW_LABELS[scope]}
            subtitle={workflowSummary(config, scope, activeMode)}
            onPress={() =>
              router.push({ pathname: '/(account)/provider-workflow', params: { scope } })
            }
          />
        ))}
      </SettingsSection>
      <View className="gap-3 px-4">
        {error ? (
          <Text accessibilityRole="alert" className="text-[14px] text-systemRed">
            {error}
          </Text>
        ) : null}
        {notice ? (
          <Text accessibilityLiveRegion="polite" className="text-[14px] text-secondaryLabel">
            {notice}
          </Text>
        ) : null}
        <Button variant="ghost" disabled={busy} onPress={removeAllCredentials}>
          Remove all provider keys
        </Button>
      </View>
    </SettingsScreen>
  );
}
