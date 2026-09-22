import React, { useEffect, useRef, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import { SettingsRow, SettingsSection } from '@/components/ui/SettingsSection';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import {
  getProviderCredentialReference,
  getProviderCredentialStatus,
  removeProviderCredential,
  setProviderCredential,
} from '@/services/providers/ProviderCredentials';
import {
  discoverProviderModels,
  testProviderConnection,
  ProviderExecutionError,
} from '@/services/providers/ProviderExecution';
import { getProviderPolicy } from '@/services/providers/ProviderPolicy';
import { isSecureHttpEndpoint, normalizeBaseUrl } from '@shared/ai/endpoints';
import { pickDefaultModelId } from '@shared/ai/providerDefaultModel';
import {
  getProvidersForScope,
  resolveInferenceRoute,
  type InferenceMode,
  type InferenceScope,
  type InferenceSelection,
} from '@shared/ai/routing';

const SCOPES: Record<InferenceScope, string> = {
  dictation: 'Dictation & Keyboard',
  upload: 'Uploads',
  meeting: 'Live Meetings',
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
  anthropic: 'https://console.anthropic.com/settings/keys',
  groq: 'https://console.groq.com/keys',
  xai: 'https://console.x.ai',
  mistral: 'https://console.mistral.ai/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  corti: 'https://www.corti.ai/',
  tinfoil: 'https://tinfoil.sh/inference',
  deepgram: 'https://console.deepgram.com/',
  assemblyai: 'https://www.assemblyai.com/dashboard/api-keys',
  openrouter: 'https://openrouter.ai/keys',
};

export function ProviderSettingsScreen(): React.JSX.Element {
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const setActiveMode = useProcessingModeStore((state) => state.setActiveMode);
  const activeMode = useProcessingModeStore((state) => state.activeMode);
  const [scope, setScope] = useState<InferenceScope>('dictation');
  const [selection, setSelection] = useState<InferenceSelection>(
    config?.inference?.dictation ?? {
      mode:
        config?.defaultMode === 'private'
          ? 'local'
          : config?.defaultMode === 'providers'
            ? 'providers'
            : 'openwhispr',
    },
  );
  const remembered = useRef<Record<string, InferenceSelection>>({});
  const [picker, setPicker] = useState<Picker | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
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
  const providers = getProvidersForScope(scope);
  const provider =
    providers.find((candidate) => candidate.id === selection.providerId) ?? providers[0];
  const modelId = selection.modelId ?? pickDefaultModelId(provider);
  const providerId = provider?.id;
  const models = provider?.models.length ? provider.models : discoveredModels;

  function clearInputs(): void {
    setApiKey('');
    setClientId('');
    setClientSecret('');
    setError(null);
    setNotice(null);
  }

  useEffect(() => {
    let cancelled = false;
    setConfigured(false);
    if (Platform.OS === 'ios' && selection.mode === 'providers' && providerId) {
      getProviderCredentialReference(providerId, selection.endpoint)
        .then(getProviderCredentialStatus)
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

  function chooseScope(next: InferenceScope): void {
    remembered.current[scope] = selection;
    setScope(next);
    setDiscoveredModels([]);
    setSelection(remembered.current[next] ?? config?.inference?.[next] ?? { mode: 'openwhispr' });
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

  async function prepareSelection(requireModel = true): Promise<InferenceSelection | null> {
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
      const hasNewCredential =
        provider.id === 'corti' ? !!(clientId.trim() || clientSecret.trim()) : !!apiKey.trim();
      if (
        provider.id === 'corti' &&
        hasNewCredential &&
        !(clientId.trim() && clientSecret.trim())
      ) {
        setError('Enter both the Corti client ID and client secret.');
        return null;
      }
      let hasCredential = (await getProviderCredentialStatus(reference)).isConfigured;
      if (hasNewCredential) {
        await setProviderCredential(
          reference,
          provider.id === 'corti'
            ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() }
            : { apiKey: apiKey.trim() },
        );
        hasCredential = true;
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
        ...(provider.id === 'corti'
          ? {
              cortiEnvironment: selection.cortiEnvironment ?? 'us',
              cortiTenant: selection.cortiTenant?.trim() || 'base',
            }
          : {}),
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
        inference: { ...useConfigStore.getState().config?.inference, [scope]: saved },
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
      const draft = await prepareSelection(action === 'test');
      if (!draft) return;
      const resolved = resolveInferenceRoute({
        scope,
        selection: draft,
        policy: await getProviderPolicy(),
        privateContent: activeMode === 'private',
      });
      if (!resolved.ok || resolved.route.mode !== 'providers') {
        setError(
          !resolved.ok && resolved.code === 'PRIVATE_CONTENT'
            ? 'Turn off Private mode before contacting a remote provider.'
            : !resolved.ok && resolved.code.startsWith('POLICY')
              ? 'Organization policy does not currently permit this provider check.'
              : 'Check your provider, model, and endpoint before testing.',
        );
        return;
      }
      if (action === 'discover') {
        const result = await discoverProviderModels({
          route: resolved.route,
          signal: controller.signal,
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
        });
        if (controller.signal.aborted) return;
        setNotice(
          result.verification === 'inference'
            ? 'Text inference succeeded for this model.'
            : result.verification === 'credentials'
              ? 'Credentials accepted. Transcription access has not been verified.'
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
          (Object.keys(SCOPES) as InferenceScope[]).map((item) =>
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
              {provider.id === 'corti' ? (
                <>
                  <Text className="text-[13px] text-secondaryLabel">Corti region</Text>
                  <View className="flex-row gap-2">
                    {(['us', 'eu'] as const).map((cortiEnvironment) => (
                      <Button
                        key={cortiEnvironment}
                        variant={
                          (selection.cortiEnvironment ?? 'us') === cortiEnvironment
                            ? 'default'
                            : 'outline'
                        }
                        disabled={busy}
                        onPress={() => setSelection({ ...selection, cortiEnvironment })}
                      >
                        {cortiEnvironment.toUpperCase()}
                      </Button>
                    ))}
                  </View>
                  <Input
                    label="Tenant"
                    accessibilityLabel="Corti tenant"
                    value={selection.cortiTenant ?? 'base'}
                    onChangeText={(cortiTenant) => setSelection({ ...selection, cortiTenant })}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!busy}
                  />
                  <Input
                    label="Client ID"
                    accessibilityLabel="Client ID"
                    value={clientId}
                    onChangeText={setClientId}
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!busy}
                  />
                  <Input
                    label="Client secret"
                    accessibilityLabel="Client secret"
                    value={clientSecret}
                    onChangeText={setClientSecret}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!busy}
                  />
                </>
              ) : (
                <Input
                  label={provider.id === 'custom' ? 'API key (optional)' : 'API key'}
                  accessibilityLabel="API key"
                  value={apiKey}
                  onChangeText={setApiKey}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={
                    configured ? 'Leave blank to keep saved credential' : 'Enter API key'
                  }
                  editable={!busy}
                />
              )}
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
                Checks save the credential entered above. Text checks send a short test prompt and
                may incur provider charges; transcription checks verify credentials or catalog
                access only.
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
      </View>
    </SettingsScreen>
  );
}
