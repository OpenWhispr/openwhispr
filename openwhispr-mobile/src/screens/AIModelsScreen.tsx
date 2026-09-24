import React, { useEffect, useState } from 'react';
import { Platform, View } from 'react-native';
import { router } from 'expo-router';
import { Button } from '@/components/ui/Button';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import type { LucideIconName } from '@/components/ui/SystemIcon';
import { Text } from '@/components/ui/Text';
import { useConfigToggle } from '@/hooks/useConfigToggle';
import { confirmDestructive } from '@/lib/alerts';
import { WORKFLOW_LABELS, WORKFLOWS, workflowSummary } from '@/lib/aiWorkflows';
import { getLocalReasoningReadiness } from '@/lib/localReasoning';
import type { InferenceSelection, MobileInferenceScope } from '@/lib/mobileProviders';
import {
  clearProviderCredentials,
  getProviderCredentialReference,
  getProviderCredentialStatus,
  subscribeProviderCredentialChanges,
} from '@/services/providers/ProviderCredentials';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { LocalReasoningReadiness } from '@/types';

const WORKFLOW_ICONS: Record<MobileInferenceScope, { icon: string; mdIcon: LucideIconName }> = {
  dictation: { icon: 'waveform', mdIcon: 'AudioLines' },
  upload: { icon: 'square.and.arrow.up', mdIcon: 'Upload' },
  cleanup: { icon: 'sparkles', mdIcon: 'Sparkles' },
  notes: { icon: 'doc.text', mdIcon: 'FileText' },
  agent: { icon: 'bubble.left.and.bubble.right', mdIcon: 'MessagesSquare' },
};

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

// Same lookup the workflow page uses; a key that exists but cannot be read is not reported missing.
async function isKeyMissing(selection: InferenceSelection | undefined): Promise<boolean> {
  if (selection?.mode !== 'providers' || !selection.providerId) return false;
  // A Custom endpoint may run without a key unless one was saved for it.
  if (selection.providerId === 'custom' && !selection.credentialRef) return false;
  try {
    const reference = await getProviderCredentialReference(
      selection.providerId,
      selection.endpoint,
    );
    const status = await getProviderCredentialStatus(reference).catch(() => ({
      isConfigured: true,
    }));
    return !status.isConfigured;
  } catch {
    return false;
  }
}

export default function AIModelsScreen(): React.JSX.Element {
  const config = useConfigStore((state) => state.config);
  const activeMode = useProcessingModeStore((state) => state.activeMode);
  const [localReadiness, setLocalReadiness] = useState<LocalReasoningReadiness | null>(null);
  const localIntelligenceEnabled = config?.appleLocalIntelligenceEnabled ?? true;
  const handleToggleLocalIntelligence = useConfigToggle('appleLocalIntelligenceEnabled');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [missingKeys, setMissingKeys] = useState<MobileInferenceScope[]>([]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    let cancelled = false;
    const check = (): void => {
      Promise.all(WORKFLOWS.map((scope) => isKeyMissing(config?.inference?.[scope]))).then(
        (missing) => {
          if (cancelled) return;
          const next = WORKFLOWS.filter((_, index) => missing[index]);
          setMissingKeys((current) => (current.join() === next.join() ? current : next));
        },
      );
    };
    check();
    const unsubscribe = subscribeProviderCredentialChanges(check);
    return (): void => {
      cancelled = true;
      unsubscribe();
    };
  }, [config]);

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
        Each workflow picks its own mode.
      </Text>
      <SettingsSection title="Workflows">
        {WORKFLOWS.map((scope) => (
          <SettingsRow
            key={scope}
            iconStyle="line"
            {...WORKFLOW_ICONS[scope]}
            title={WORKFLOW_LABELS[scope]}
            subtitle={workflowSummary(config, scope, activeMode, missingKeys.includes(scope))}
            onPress={() => router.push({ pathname: '/(account)/ai-workflow', params: { scope } })}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="On-Device">
        <SettingsRow
          iconStyle="line"
          icon="sparkles"
          mdIcon="Sparkles"
          title="Local Apple Intelligence"
          description={`Status: ${localReasoningStatusLabel(localReadiness)}. Runs On-Device text workflows, and private and signed-out note generation.`}
          rightElement={
            <SettingsSwitch
              value={localIntelligenceEnabled}
              onValueChange={handleToggleLocalIntelligence}
            />
          }
          showChevron={false}
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
      {Platform.OS === 'ios' ? (
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
      ) : null}
    </SettingsScreen>
  );
}
