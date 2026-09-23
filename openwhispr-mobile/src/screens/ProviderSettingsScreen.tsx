import React, { useEffect, useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { ProcessingMode, UserConfig } from '@/types';
import {
  clearProviderCredentials,
  getProviderCredentialReference,
  getProviderCredentialStatus,
  removeProviderCredential,
  setProviderCredential,
} from '@/services/providers/ProviderCredentials';
import { confirmDestructive } from '@/lib/alerts';
import { dictationModeConfig } from '@/lib/inferenceModes';
import {
  discoverProviderModels,
  testProviderConnection,
  ProviderExecutionError,
} from '@/services/providers/ProviderExecution';
import { getProviderPolicy } from '@/services/providers/ProviderPolicy';
import { isSecureHttpEndpoint, normalizeBaseUrl } from '@shared/ai/endpoints';
import { pickDefaultModelId } from '@shared/ai/providerDefaultModel';
import { type InferenceMode, type InferenceSelection } from '@shared/ai/routing';
import {
  getMobileProvidersForScope,
  resolveMobileInferenceRoute,
  type MobileInferenceScope,
} from '@/lib/mobileProviders';

const SCOPES: Record<MobileInferenceScope, string> = {
  dictation: 'Dictation & Keyboard',
  upload: 'Uploads',
  cleanup: 'Text Cleanup',
  notes: 'Note Formatting & Titles',
  agent: 'Chat & Agents',
};
const MODES: Record<InferenceMode, string> = {
  openwhispr: 'OpenWhispr Cloud',
  local: 'On-Device',
  providers: 'Providers',
};
type Picker = 'scope' | 'mode' | 'provider' | 'model';
const PROVIDER_SETUP_URLS: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  groq: 'https://console.groq.com/keys',
  openrouter: 'https://openrouter.ai/keys',
};

// Providers dictation skips these workflows until a selection is saved for them.
const UNSET_PROVIDER_NOTES: Partial<Record<MobileInferenceScope, string>> = {
  cleanup: 'Not saved yet. Cleanup is skipped until you save a selection.',
  agent:
    'Not saved yet. Voice commands are skipped until you save a selection; note chat uses OpenWhispr Cloud.',
};

// What a workflow with no saved selection runs: On-Device mode keeps everything
// local, and Providers dictation waits for a provider before cleanup or the agent.
function unsetSelection(
  scope: MobileInferenceScope,
  activeMode: ProcessingMode,
): InferenceSelection {
  if (activeMode === 'private') return { mode: 'local' };
  if (activeMode === 'providers' && (scope === 'dictation' || UNSET_PROVIDER_NOTES[scope]))
    return { mode: 'providers' };
  return { mode: 'openwhispr' };
}

export function ProviderSettingsScreen(): React.JSX.Element {
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const setActiveMode = useProcessingModeStore((state) => state.setActiveMode);
  const activeMode = useProcessingModeStore((state) => state.activeMode);
  const [scope, setScope] = useState<MobileInferenceScope>('dictation');
  const [selection, setSelection] = useState<InferenceSelection>(
    config?.inference?.dictation ?? unsetSelection('dictation', activeMode),
  );
  const remembered = useRef<Record<string, InferenceSelection>>({});
  const [picker, setPicker] = useState<Picker | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<{ id: string; name: string }[]>([]);
  const diagnosticController = useRef<AbortController | null>(null);
  useEffect(
    () => (): void => {
      diagnosticController.current?.abort();
    },
    [],
  );
  const providers = getMobileProvidersForScope(scope);
  const provider =
    providers.find((candidate) => candidate.id === selection.providerId) ?? providers[0];
  const modelId = selection.modelId ?? pickDefaultModelId(provider);
  const providerId = provider?.id;
  const models = provider?.models.length ? provider.models : discoveredModels;
  const unsetNote =
    activeMode === 'providers' && !config?.inference?.[scope]
      ? UNSET_PROVIDER_NOTES[scope]
      : undefined;

  function clearInputs(): void {
    setApiKey('');
    setError(null);
    setNotice(null);
  }

  useEffect(() => {
    let cancelled = false;
    setConfigured(false);
    if (Platform.OS === 'ios' && selection.mode === 'providers' && providerId) {
      getProviderCredentialReference(providerId, selection.endpoint)
        .then((reference) =>
          // An unreadable saved key still exists, so offer to remove it.
          getProviderCredentialStatus(reference).catch(() => ({ reference, isConfigured: true })),
        )
        .then((status) => {
          if (!cancelled) setConfigured(status.isConfigured);
        })
        .catch(() => {
          /* Invalid custom endpoints are explained when saving. */
        });
    }
    return (): void => {
      cancelled = true;
    };
  }, [providerId, selection.endpoint, selection.mode]);

  function openPicker(next: Picker): void {
    setPicker(picker === next ? null : next);
  }

  function chooseScope(next: MobileInferenceScope): void {
    remembered.current[scope] = selection;
    setScope(next);
    setDiscoveredModels([]);
    setSelection(
      remembered.current[next] ?? config?.inference?.[next] ?? unsetSelection(next, activeMode),
    );
    setPicker(null);
    clearInputs();
  }

  function chooseProvider(nextProviderId: string): void {
    setDiscoveredModels([]);
    if (provider) remembered.current[`${scope}:${provider.id}`] = { ...selection, modelId };
    const next = providers.find((candidate) => candidate.id === nextProviderId);
    setSelection(
      remembered.current[`${scope}:${nextProviderId}`] ??
        config?.rememberedInference?.[scope]?.[nextProviderId] ?? {
          mode: 'providers',
          providerId: nextProviderId,
          modelId: pickDefaultModelId(next),
        },
    );
    setPicker(null);
    clearInputs();
  }

  async function prepareSelection(
    requireModel = true,
    saveCredential = true,
  ): Promise<InferenceSelection | null> {
    let saved: InferenceSelection = { mode: selection.mode };
    if (selection.mode === 'providers') {
      if (!provider || (requireModel && !modelId.trim())) {
        setError('Choose a provider and enter a model ID.');
        return null;
      }
      const endpoint = normalizeBaseUrl(
        provider.id === 'custom' ? selection.endpoint : provider.endpoint,
      );
      if (provider.id === 'custom') {
        if (!isSecureHttpEndpoint(endpoint)) {
          setError('Use HTTPS, or HTTP for a private-network host.');
          return null;
        }
        const parsed = new URL(endpoint);
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
          setError('Remove credentials, query parameters, and fragments from the endpoint URL.');
          return null;
        }
      }
      const reference = await getProviderCredentialReference(provider.id, endpoint);
      const hasNewCredential = !!apiKey.trim();
      const hasCredential =
        hasNewCredential || (await getProviderCredentialStatus(reference)).isConfigured;
      if (hasNewCredential && saveCredential) {
        await setProviderCredential(reference, { apiKey: apiKey.trim() });
        clearInputs();
        setConfigured(true);
      }
      if (provider.id !== 'custom' && !hasCredential) {
        setError('Enter a credential for this provider.');
        return null;
      }
      saved = {
        mode: 'providers',
        providerId: provider.id,
        modelId: modelId.trim() || 'catalog-probe',
        ...(provider.id === 'custom' ? { endpoint } : {}),
        ...(hasCredential ? { credentialRef: reference } : {}),
      };
    }
    return saved;
  }

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await prepareSelection();
      if (!saved) return;
      const processingMode =
        saved.mode === 'local' ? 'private' : saved.mode === 'providers' ? 'providers' : 'cloud';
      const currentConfig = useConfigStore.getState().config;
      const inference: UserConfig['inference'] =
        scope === 'dictation' && processingMode !== 'providers'
          ? dictationModeConfig(currentConfig, processingMode).inference
          : {
              ...currentConfig?.inference,
              // Pin uploads to the mode dictation is leaving for Providers.
              ...(scope === 'dictation' && !currentConfig?.inference?.upload
                ? { upload: { mode: activeMode === 'private' ? 'local' : 'openwhispr' } }
                : {}),
              [scope]: saved,
            };
      await updateConfig({
        ...(saved.providerId
          ? {
              rememberedInference: {
                ...currentConfig?.rememberedInference,
                [scope]: {
                  ...currentConfig?.rememberedInference?.[scope],
                  [saved.providerId]: saved,
                },
              },
            }
          : {}),
        inference,
        ...(scope === 'dictation' ? { defaultMode: processingMode } : {}),
      });
      if (useConfigStore.getState().error) {
        setError('Unable to save your selection. Please try again.');
        return;
      }
      if (scope === 'dictation') setActiveMode(processingMode, true);
      remembered.current[scope] = saved;
      setSelection(saved);
      clearInputs();
      setNotice('Selection saved.');
    } catch {
      setError('Unable to save provider settings. Check your configuration and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function diagnose(action: 'test' | 'discover'): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    diagnosticController.current = controller;
    try {
      const draft = await prepareSelection(action === 'test', false);
      if (!draft) return;
      const resolved = resolveMobileInferenceRoute({
        scope,
        selection: draft,
        // A check sends no user content, so On-Device mode does not block it.
        policy: await getProviderPolicy(),
      });
      if (!resolved.ok || resolved.route.mode !== 'providers') {
        setError(
          !resolved.ok && resolved.code.startsWith('POLICY')
            ? 'Organization policy does not currently permit this provider check.'
            : 'Check your provider, model, and endpoint before testing.',
        );
        return;
      }
      if (action === 'discover') {
        const result = await discoverProviderModels({
          route: resolved.route,
          signal: controller.signal,
          apiKey: apiKey.trim() || undefined,
        });
        if (controller.signal.aborted) return;
        setDiscoveredModels(result.models);
        setNotice(
          result.models.length
            ? 'Model catalog loaded. Inference access has not been verified.'
            : 'No models were listed. You can still enter a model ID manually.',
        );
      } else {
        const result = await testProviderConnection({
          route: resolved.route,
          signal: controller.signal,
          apiKey: apiKey.trim() || undefined,
        });
        if (controller.signal.aborted) return;
        setNotice(
          result.verification === 'inference'
            ? 'Text inference succeeded for this model.'
            : 'Model catalog accessible. Transcription and inference access have not been verified.',
        );
      }
    } catch (failure: unknown) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof ProviderExecutionError
            ? failure.message
            : 'Unable to check this provider. Check the endpoint and connection, then try again.',
        );
    } finally {
      diagnosticController.current = null;
      setBusy(false);
    }
  }

  async function removeCredential(): Promise<void> {
    if (!provider) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const reference = await getProviderCredentialReference(provider.id, selection.endpoint);
      await removeProviderCredential(reference);
      setConfigured(false);
      clearInputs();
      setNotice('Credential removed for every workflow using it.');
    } catch {
      setError('Unable to remove this credential. Please try again.');
    } finally {
      setBusy(false);
    }
  }

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
          setConfigured(false);
          clearInputs();
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

  function choice(title: string, selected: boolean, onPress: () => void): React.JSX.Element {
    return (
      <SettingsRow
        key={title}
        icon={selected ? 'checkmark.circle.fill' : 'circle'}
        mdIcon={selected ? 'CircleCheck' : 'Circle'}
        iconStyle="line"
        title={title}
        selected={selected}
        showChevron={false}
        onPress={busy ? undefined : onPress}
      />
    );
  }

  if (Platform.OS !== 'ios') {
    return (
      <SettingsScreen>
        <Text className="px-8 text-[15px] text-secondaryLabel">
          Provider setup is available on iOS. Cloud and on-device settings remain available on
          Android.
        </Text>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      <Text className="mb-4 px-8 text-[13px] text-secondaryLabel">
        Use your own provider without an OpenWhispr account or Pro. Your provider bills usage
        separately.
      </Text>
      <SettingsSection>
        <SettingsRow
          icon="slider.horizontal.3"
          mdIcon="SlidersHorizontal"
          iconStyle="line"
          title="Workflow"
          subtitle={SCOPES[scope]}
          onPress={busy ? undefined : () => openPicker('scope')}
        />
        {picker === 'scope' &&
          (Object.keys(SCOPES) as MobileInferenceScope[]).map((item) =>
            choice(SCOPES[item], item === scope, () => chooseScope(item)),
          )}
        <SettingsRow
          icon="cpu"
          mdIcon="Cpu"
          iconStyle="line"
          title="Inference mode"
          subtitle={MODES[selection.mode]}
          onPress={busy ? undefined : () => openPicker('mode')}
        />
        {picker === 'mode' &&
          (Object.keys(MODES) as InferenceMode[]).map((mode) =>
            choice(MODES[mode], mode === selection.mode, () => {
              setSelection(
                mode === 'providers' && !selection.providerId && provider
                  ? (config?.rememberedInference?.[scope]?.[provider.id] ?? {
                      mode,
                      providerId: provider.id,
                      modelId: pickDefaultModelId(provider),
                    })
                  : { ...selection, mode },
              );
              setPicker(null);
              clearInputs();
            }),
          )}
      </SettingsSection>
      {unsetNote ? (
        <Text className="-mt-4 mb-6 px-8 text-[13px] text-secondaryLabel">{unsetNote}</Text>
      ) : null}
      {selection.mode === 'providers' && provider ? (
        <>
          <SettingsSection title="Connection">
            <SettingsRow
              icon="network"
              mdIcon="Network"
              iconStyle="line"
              title="Provider"
              subtitle={provider.name}
              onPress={busy ? undefined : () => openPicker('provider')}
            />
            {picker === 'provider' &&
              providers.map((item) =>
                choice(item.name, item.id === provider.id, () => chooseProvider(item.id)),
              )}
            {models.length > 0 ? (
              <SettingsRow
                icon="square.stack"
                mdIcon="Layers"
                iconStyle="line"
                title="Model"
                subtitle={models.find((model) => model.id === modelId)?.name ?? modelId}
                onPress={busy ? undefined : () => openPicker('model')}
              />
            ) : null}
            {picker === 'model' &&
              models.map((model) =>
                choice(model.name, model.id === modelId, () => {
                  setSelection({ ...selection, modelId: model.id });
                  setPicker(null);
                  setNotice(null);
                }),
              )}
          </SettingsSection>
          <SettingsSection
            borderless
            title={configured ? 'Credential saved on this device' : 'Credentials'}
          >
            <View className="gap-3 p-1">
              {provider.id === 'custom' ? (
                <>
                  <Input
                    label="Endpoint URL"
                    accessibilityLabel="Endpoint URL"
                    value={selection.endpoint ?? ''}
                    onChangeText={(endpoint) => {
                      setSelection({ ...selection, endpoint });
                      clearInputs();
                    }}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    placeholder="https://your-server.example/v1"
                    editable={!busy}
                  />
                  <Text className="text-[13px] text-secondaryLabel">
                    On iPhone, localhost refers to this iPhone. Use your server's LAN address for a
                    local server.
                  </Text>
                </>
              ) : null}
              {!provider.models.length ? (
                <Input
                  label="Model ID"
                  accessibilityLabel="Model ID"
                  value={modelId}
                  onChangeText={(nextModel) => setSelection({ ...selection, modelId: nextModel })}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                />
              ) : null}
              <Input
                label={provider.id === 'custom' ? 'API key (optional)' : 'API key'}
                accessibilityLabel="API key"
                value={apiKey}
                onChangeText={setApiKey}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={configured ? 'Leave blank to keep saved credential' : 'Enter API key'}
                editable={!busy}
              />
              {PROVIDER_SETUP_URLS[provider.id] ? (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onPress={async (): Promise<void> => {
                    try {
                      await Linking.openURL(PROVIDER_SETUP_URLS[provider.id]);
                    } catch {
                      setError('Unable to open the provider website. Please try again.');
                    }
                  }}
                >
                  Get provider credentials
                </Button>
              ) : null}
              {configured ? (
                <Button variant="ghost" disabled={busy} onPress={removeCredential}>
                  Remove credential
                </Button>
              ) : null}
            </View>
          </SettingsSection>
          <SettingsSection borderless title="Verify access">
            <View className="gap-3 p-1">
              <Text className="text-[13px] text-secondaryLabel">
                Checks use the key entered above without saving it. Text checks send a short test
                prompt and may incur provider charges; transcription checks verify catalog access
                only.
              </Text>
              <Button variant="outline" disabled={busy} onPress={() => diagnose('test')}>
                Check connection
              </Button>
              {provider.id === 'custom' || provider.id === 'openrouter' ? (
                <Button variant="outline" disabled={busy} onPress={() => diagnose('discover')}>
                  Discover models
                </Button>
              ) : null}
            </View>
          </SettingsSection>
        </>
      ) : null}
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
        <Button loading={busy} onPress={save}>
          Save selection
        </Button>
        <Button variant="ghost" disabled={busy} onPress={removeAllCredentials}>
          Remove all provider keys
        </Button>
      </View>
    </SettingsScreen>
  );
}
