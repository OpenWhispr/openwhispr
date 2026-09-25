import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Linking, Platform, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from '@react-navigation/elements';
import { useNavigation, usePreventRemove } from '@react-navigation/native';
import { SettingsScreen } from '@/components/ui/SettingsScreen';
import {
  SettingsRow,
  SettingsSection,
  SettingsTextFieldRow,
} from '@/components/ui/SettingsSection';
import { Text } from '@/components/ui/Text';
import { Toast } from '@/components/ui/Toast';
import { useToast } from '@/hooks/useToast';
import { confirmDestructive } from '@/lib/alerts';
import { SettingsSwitch } from '@/components/ui/SettingsSwitch';
import { OnDeviceModelSection } from '@/components/settings/OnDeviceModelSection';
import { useConfigToggle } from '@/hooks/useConfigToggle';
import { useCustomPromptsStore } from '@/store/useCustomPromptsStore';
import { resolveCustomPrompt } from '@/config/prompts/registry';
import { useConfigStore } from '@/store/useConfigStore';
import { useProcessingModeStore } from '@/store/useProcessingModeStore';
import type { UserConfig } from '@/types';
import {
  type ProviderCredential,
  getProviderCredential,
  getProviderCredentialReference,
  getProviderCredentialStatus,
  removeProviderCredential,
  setProviderCredential,
} from '@/services/providers/ProviderCredentials';
import { workflowSaveConfig } from '@/lib/inferenceModes';
import { InferenceModePicker } from '@/components/settings/InferenceModePicker';
import {
  ON_DEVICE_MODE_NOTES,
  UNSET_PROVIDER_NOTES,
  WORKFLOW_LABELS,
  WORKFLOWS,
  parseWorkflow,
  unsetSelection,
} from '@/lib/aiWorkflows';
import { isLocalModelKey } from '@/lib/localModelCatalog';
import { switchWorkflowMode } from '@/lib/workflowModeSwitch';
import {
  discoverProviderModels,
  testProviderConnection,
  ProviderExecutionError,
} from '@/services/providers/ProviderExecution';
import { getProviderPolicy } from '@/services/providers/ProviderPolicy';
import {
  getModelListBaseCandidates,
  isSecureHttpEndpoint,
  normalizeBaseUrl,
} from '@/lib/providerEndpoints';
import {
  defaultModelId,
  getMobileProvidersForScope,
  providerDisplayName,
  resolveMobileInferenceRoute,
  type InferenceMode,
  type InferenceSelection,
  type MobileInferenceScope,
} from '@/lib/mobileProviders';

type Picker = 'provider' | 'model';
const PROVIDER_SETUP_URLS: Record<string, string> = {
  openai: 'https://platform.openai.com/api-keys',
  groq: 'https://console.groq.com/keys',
  openrouter: 'https://openrouter.ai/keys',
};

function SectionFooter({ children }: { children: string }): React.JSX.Element {
  return (
    <View className="mx-4 -mt-5 mb-7 px-4">
      <Text className="text-[13px] text-secondaryLabel">{children}</Text>
    </View>
  );
}

function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function CleanupSettings({ enabled }: { enabled: boolean }): React.JSX.Element {
  const toggleCleanup = useConfigToggle('cleanupEnabled');
  const hasCustomPrompt = useCustomPromptsStore(
    (state) => resolveCustomPrompt(state.customPrompts.cleanup) !== undefined,
  );
  return (
    <>
      <SettingsSection>
        <SettingsRow
          iconStyle="line"
          icon="sparkles"
          mdIcon="Sparkles"
          title="Enable Text Cleanup"
          description="Use AI to remove filler words, fix grammar, and polish punctuation."
          rightElement={<SettingsSwitch value={enabled} onValueChange={toggleCleanup} />}
          showChevron={false}
        />
        {enabled ? (
          <SettingsRow
            iconStyle="line"
            icon="text.quote"
            mdIcon="TextQuote"
            title="Cleanup Prompt"
            subtitle={hasCustomPrompt ? 'Custom' : 'Default'}
            onPress={() => router.push('/(account)/cleanup-prompt')}
          />
        ) : null}
      </SettingsSection>
      {enabled ? null : (
        <SectionFooter>Dictation is inserted as spoken, with no AI cleanup.</SectionFooter>
      )}
    </>
  );
}

function NoteTitleSettings(): React.JSX.Element {
  const autoTitle = useConfigStore((state) => state.config?.autoGenerateNoteTitle ?? true);
  const toggleAutoTitle = useConfigToggle('autoGenerateNoteTitle');
  return (
    <SettingsSection title="Settings">
      <SettingsRow
        iconStyle="line"
        icon="textformat"
        mdIcon="Type"
        title="Auto-generate Note Titles"
        description="Use AI to generate a short title for notes after enhancement."
        rightElement={<SettingsSwitch value={autoTitle} onValueChange={toggleAutoTitle} />}
        showChevron={false}
      />
    </SettingsSection>
  );
}

export function WorkflowSettingsScreen(): React.JSX.Element {
  const scope = parseWorkflow(useLocalSearchParams<{ scope?: string }>().scope);
  if (!scope) {
    return (
      <SettingsScreen>
        <Text className="px-8 text-[15px] text-secondaryLabel">
          This workflow is not available.
        </Text>
      </SettingsScreen>
    );
  }
  return <WorkflowSettings scope={scope} />;
}

// The provider used last for this workflow, else the first one offered.
function providerSelection(
  config: UserConfig | null,
  scope: MobileInferenceScope,
): InferenceSelection {
  const providers = getMobileProvidersForScope(scope);
  const remembered = Object.values(config?.rememberedInference?.[scope] ?? {}).find((saved) =>
    providers.some((candidate) => candidate.id === saved.providerId),
  );
  return (
    remembered ?? {
      mode: 'providers',
      providerId: providers[0]?.id,
      modelId: defaultModelId(providers[0]),
    }
  );
}

function WorkflowSettings({ scope }: { scope: MobileInferenceScope }): React.JSX.Element {
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const setActiveMode = useProcessingModeStore((state) => state.setActiveMode);
  const activeMode = useProcessingModeStore((state) => state.activeMode);
  const savedSelection = config?.inference?.[scope] ?? unsetSelection(scope, activeMode);
  // Tracks the saved selection, except while a Bring Your Own Key draft is being set up.
  const [selection, setSelection] = useState<InferenceSelection>(savedSelection);
  const remembered = useRef<Record<string, InferenceSelection>>({});
  const [picker, setPicker] = useState<Picker | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState<'test' | 'discover' | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<{ id: string; name: string }[]>([]);
  const { toast, showToast } = useToast();
  const headerHeight = useHeaderHeight();
  const navigation = useNavigation();
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
  const modelId = selection.modelId ?? defaultModelId(provider);
  const providerId = provider?.id;
  const models = provider?.models.length ? provider.models : discoveredModels;
  const modeNote =
    (activeMode === 'private' ? ON_DEVICE_MODE_NOTES[scope] : undefined) ??
    (activeMode === 'providers' && !config?.inference?.[scope]
      ? UNSET_PROVIDER_NOTES[scope]
      : undefined) ??
    (selection.mode === 'providers' && savedSelection.mode !== 'providers'
      ? 'Save to switch to Bring Your Own Key.'
      : undefined);
  const speechScope = scope === 'dictation' || scope === 'upload' ? scope : null;
  const cleanupOff = scope === 'cleanup' && !(config?.cleanupEnabled ?? true);
  // Keys are stored per provider (per server for Custom), so every workflow on it shares one.
  const keyOwner =
    provider?.id === 'custom' ? 'this server' : providerDisplayName(provider?.id ?? '');
  const sharedWith = WORKFLOWS.filter((other) => {
    const saved = config?.inference?.[other];
    return (
      other !== scope &&
      saved?.mode === 'providers' &&
      saved.providerId === provider?.id &&
      (provider?.id !== 'custom' ||
        normalizeBaseUrl(saved.endpoint) === normalizeBaseUrl(selection.endpoint))
    );
  }).map((other) => WORKFLOW_LABELS[other]);
  const keyFooter = sharedWith.length
    ? `Stays on this iPhone. Also used by ${joinNames(sharedWith)}.`
    : provider?.id === 'custom'
      ? 'Stays on this iPhone. Every workflow using this server uses the same key.'
      : `Stays on this iPhone. Every workflow set to ${keyOwner} uses the same key.`;

  // A passing check looks like finished setup, so leaving must not drop the key silently.
  const hasUnsavedChanges =
    !!apiKey.trim() ||
    selection.mode !== savedSelection.mode ||
    (selection.mode === 'providers' &&
      (selection.providerId !== savedSelection.providerId ||
        modelId !== savedSelection.modelId ||
        (selection.endpoint ?? '') !== (savedSelection.endpoint ?? '')));
  const canSave = hasUnsavedChanges && !busy;
  usePreventRemove(hasUnsavedChanges, ({ data }) =>
    confirmDestructive(
      'Discard unsaved changes?',
      'Your selection and any key you entered have not been saved.',
      () => navigation.dispatch(data.action),
      { destructiveLabel: 'Discard' },
    ),
  );

  function clearInputs(): void {
    setApiKey('');
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

  const showError = (message: string): void => showToast(message, 'error');

  function openPicker(next: Picker): void {
    setPicker(picker === next ? null : next);
  }

  async function chooseMode(mode: InferenceMode): Promise<void> {
    if (busy) return;
    setPicker(null);
    clearInputs();
    // Bring Your Own Key needs a provider and key, so it switches on Save.
    if (mode === 'providers') {
      setSelection(
        selection.providerId ? { ...selection, mode } : providerSelection(config, scope),
      );
      return;
    }
    if (mode === savedSelection.mode) {
      setSelection(savedSelection);
      return;
    }
    setBusy(true);
    try {
      if (await switchWorkflowMode(scope, mode)) {
        setSelection(useConfigStore.getState().config?.inference?.[scope] ?? { mode });
      }
    } finally {
      setBusy(false);
    }
  }

  function chooseProvider(nextProviderId: string): void {
    setDiscoveredModels([]);
    if (provider) remembered.current[provider.id] = { ...selection, modelId };
    const next = providers.find((candidate) => candidate.id === nextProviderId);
    setSelection(
      remembered.current[nextProviderId] ??
        config?.rememberedInference?.[scope]?.[nextProviderId] ?? {
          mode: 'providers',
          providerId: nextProviderId,
          modelId: defaultModelId(next),
        },
    );
    setPicker(null);
    clearInputs();
  }

  async function prepareSelection(
    requireModel = true,
    saveCredential = true,
    onInvalid: (message: string) => void = showError,
  ): Promise<InferenceSelection | null> {
    let saved: InferenceSelection = { mode: selection.mode };
    if (selection.mode === 'providers') {
      if (!provider || (requireModel && !modelId.trim())) {
        onInvalid('Choose a provider and enter a model ID.');
        return null;
      }
      const endpoint = normalizeBaseUrl(
        provider.id === 'custom' ? selection.endpoint : provider.endpoint,
      );
      if (provider.id === 'custom') {
        if (!isSecureHttpEndpoint(endpoint)) {
          onInvalid('Use HTTPS, or HTTP for a private-network host.');
          return null;
        }
        const parsed = new URL(endpoint);
        if (parsed.username || parsed.password || parsed.search || parsed.hash) {
          onInvalid('Remove credentials, query parameters, and fragments from the endpoint URL.');
          return null;
        }
      }
      const reference = await getProviderCredentialReference(provider.id, endpoint);
      const hasNewCredential = !!apiKey.trim();
      let hasCredential =
        hasNewCredential || (await getProviderCredentialStatus(reference)).isConfigured;
      const carried = !hasCredential && saveCredential && (await savedServerCredential(endpoint));
      if (carried) {
        await setProviderCredential(reference, carried);
        hasCredential = true;
      }
      if (hasNewCredential && saveCredential) {
        await setProviderCredential(reference, { apiKey: apiKey.trim() });
        clearInputs();
        setConfigured(true);
      }
      if (provider.id !== 'custom' && !hasCredential) {
        onInvalid('Enter a credential for this provider.');
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

  // A check can move a saved custom server to the /v1 address it answers on. Its key
  // goes with it, but never to another host.
  async function savedServerCredential(endpoint: string): Promise<ProviderCredential | null> {
    const previous = savedSelection;
    if (
      previous.providerId !== 'custom' ||
      !previous.endpoint ||
      !previous.credentialRef ||
      !getModelListBaseCandidates(previous.endpoint).includes(endpoint)
    )
      return null;
    return getProviderCredential(previous.credentialRef);
  }

  // A bare server origin often serves its API under /v1; keep the address that answered.
  function adoptWorkingEndpoint(draft: InferenceSelection, endpoint: string | undefined): void {
    if (draft.providerId !== 'custom' || !endpoint || endpoint === draft.endpoint) return;
    setSelection((current) => ({ ...current, endpoint }));
  }

  async function save(): Promise<void> {
    Keyboard.dismiss();
    const enteredKey = !!apiKey.trim();
    setBusy(true);
    try {
      const saved = await prepareSelection();
      if (!saved) return;
      await updateConfig(
        workflowSaveConfig(useConfigStore.getState().config, scope, saved, activeMode),
      );
      if (useConfigStore.getState().error) {
        showError('Unable to save your selection. Please try again.');
        return;
      }
      if (scope === 'dictation') setActiveMode('providers', true);
      setSelection(saved);
      clearInputs();
      showToast(
        !enteredKey
          ? 'Saved.'
          : provider?.id === 'custom'
            ? 'Saved. Every workflow using this server uses this key.'
            : `Saved. Every workflow set to ${keyOwner} uses this key.`,
        'success',
      );
    } catch {
      showError('Unable to save provider settings. Check your configuration and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function diagnose(action: 'test' | 'discover'): Promise<void> {
    // Focus moves to the result, so the keyboard has no reason to stay up.
    Keyboard.dismiss();
    setBusy(true);
    setChecking(action);
    const controller = new AbortController();
    diagnosticController.current = controller;
    try {
      const draft = await prepareSelection(action === 'test', false, showError);
      if (!draft) return;
      const resolved = resolveMobileInferenceRoute({
        scope,
        selection: draft,
        // A check sends no user content, so On-Device mode does not block it.
        policy: await getProviderPolicy(),
      });
      if (!resolved.ok || resolved.route.mode !== 'providers') {
        showError(
          !resolved.ok && resolved.code.startsWith('POLICY')
            ? 'Organization policy does not currently permit this provider check.'
            : 'Check your provider, model, and endpoint before testing.',
        );
        return;
      }
      const checkKey =
        apiKey.trim() ||
        (!draft.credentialRef && (await savedServerCredential(draft.endpoint ?? ''))?.apiKey) ||
        undefined;
      if (action === 'discover') {
        const result = await discoverProviderModels({
          route: resolved.route,
          signal: controller.signal,
          apiKey: checkKey,
        });
        if (controller.signal.aborted) return;
        adoptWorkingEndpoint(draft, result.endpoint);
        setDiscoveredModels(result.models);
        showToast(
          result.models.length
            ? 'Model catalog loaded. Inference access has not been verified.'
            : 'No models were listed. You can still enter a model ID manually.',
          'info',
        );
      } else {
        const result = await testProviderConnection({
          route: resolved.route,
          signal: controller.signal,
          apiKey: checkKey,
        });
        if (controller.signal.aborted) return;
        adoptWorkingEndpoint(draft, result.endpoint);
        if (result.verification === 'inference')
          showToast('Connection works. Save to use it.', 'success');
        else
          showToast(
            'Model catalog accessible. Transcription and inference access have not been verified.',
            'info',
          );
      }
    } catch (failure: unknown) {
      if (!controller.signal.aborted)
        showError(
          failure instanceof ProviderExecutionError
            ? failure.message
            : 'Unable to check this provider. Check the endpoint and connection, then try again.',
        );
    } finally {
      diagnosticController.current = null;
      setChecking(null);
      setBusy(false);
    }
  }

  function removeCredential(): void {
    if (!provider) return;
    const custom = provider.id === 'custom';
    confirmDestructive(
      custom ? "Remove this server's key?" : `Remove your ${keyOwner} key?`,
      custom
        ? 'Every workflow using this server loses its key until you add one again.'
        : `Every workflow set to ${keyOwner} stops until you add a key again.`,
      async (): Promise<void> => {
        setBusy(true);
        try {
          const reference = await getProviderCredentialReference(provider.id, selection.endpoint);
          await removeProviderCredential(reference);
          setConfigured(false);
          clearInputs();
          showToast(custom ? 'Server key removed.' : `${keyOwner} key removed.`, 'success');
        } catch {
          showError('Unable to remove this key. Please try again.');
        } finally {
          setBusy(false);
        }
      },
      { destructiveLabel: 'Remove' },
    );
  }

  async function openKeyPage(url: string): Promise<void> {
    try {
      await Linking.openURL(url);
    } catch {
      showError('Unable to open the provider website. Please try again.');
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

  return (
    <View className="flex-1 bg-systemBackground">
      <SettingsScreen
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {scope === 'cleanup' ? <CleanupSettings enabled={!cleanupOff} /> : null}
        {cleanupOff ? null : (
          <>
            <InferenceModePicker
              scope={speechScope ? 'speech' : 'text'}
              selectedMode={selection.mode}
              onSelect={chooseMode}
            />
            {modeNote ? <SectionFooter>{modeNote}</SectionFooter> : null}
            {selection.mode === 'local' && speechScope ? (
              <OnDeviceModelSection
                scope={speechScope}
                picked={
                  isLocalModelKey(savedSelection.modelId) ? savedSelection.modelId : undefined
                }
              />
            ) : null}
            {selection.mode === 'local' && !speechScope ? (
              <SectionFooter>Runs on Apple Intelligence on this iPhone.</SectionFooter>
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
                      }),
                    )}
                  {provider.id === 'custom' ? (
                    <SettingsTextFieldRow
                      icon="server.rack"
                      mdIcon="Server"
                      label="Server"
                      accessibilityLabel="Server URL"
                      value={selection.endpoint ?? ''}
                      onChangeText={(endpoint) => {
                        setSelection({ ...selection, endpoint });
                        clearInputs();
                      }}
                      autoCapitalize="none"
                      keyboardType="url"
                      placeholder="https://your-server.example/v1"
                      editable={!busy}
                    />
                  ) : null}
                  {!provider.models.length ? (
                    <SettingsTextFieldRow
                      icon="square.stack"
                      mdIcon="Layers"
                      label="Model ID"
                      accessibilityLabel="Model ID"
                      value={modelId}
                      onChangeText={(nextModel) =>
                        setSelection({ ...selection, modelId: nextModel })
                      }
                      autoCapitalize="none"
                      placeholder="model-name"
                      editable={!busy}
                    />
                  ) : null}
                </SettingsSection>
                {provider.id === 'custom' ? (
                  <SectionFooter>
                    On iPhone, localhost is this iPhone. Use your server's network address.
                  </SectionFooter>
                ) : null}
                <SettingsSection title="API Key">
                  <SettingsTextFieldRow
                    icon="key"
                    mdIcon="KeyRound"
                    accessibilityLabel="API key"
                    value={apiKey}
                    onChangeText={(next) => {
                      // A paste or password-manager fill arrives as one change; typing adds one character.
                      if (next.length - apiKey.length > 1) Keyboard.dismiss();
                      setApiKey(next);
                    }}
                    secureTextEntry
                    autoCapitalize="none"
                    placeholder={
                      configured
                        ? 'Saved · enter a new key to replace it'
                        : provider.id === 'custom'
                          ? 'Optional'
                          : 'Paste your API key'
                    }
                    editable={!busy}
                  />
                  {PROVIDER_SETUP_URLS[provider.id] ? (
                    <SettingsRow
                      iconStyle="line"
                      icon="arrow.up.right.square"
                      mdIcon="ExternalLink"
                      title="Get an API Key"
                      showChevron={false}
                      onPress={
                        busy ? undefined : () => openKeyPage(PROVIDER_SETUP_URLS[provider.id])
                      }
                    />
                  ) : null}
                  {configured ? (
                    <SettingsRow
                      iconStyle="line"
                      icon="trash"
                      mdIcon="Trash2"
                      title="Remove Key"
                      destructive
                      showChevron={false}
                      onPress={busy ? undefined : removeCredential}
                    />
                  ) : null}
                </SettingsSection>
                <SectionFooter>{keyFooter}</SectionFooter>
                <SettingsSection title="Verify">
                  <SettingsRow
                    iconStyle="line"
                    icon="checkmark.shield"
                    mdIcon="ShieldCheck"
                    title="Check Connection"
                    showChevron={false}
                    rightElement={checking === 'test' ? <ActivityIndicator /> : undefined}
                    onPress={busy ? undefined : () => diagnose('test')}
                  />
                  {provider.id === 'custom' || provider.id === 'openrouter' ? (
                    <SettingsRow
                      iconStyle="line"
                      icon="magnifyingglass"
                      mdIcon="Search"
                      title="Discover Models"
                      showChevron={false}
                      rightElement={checking === 'discover' ? <ActivityIndicator /> : undefined}
                      onPress={busy ? undefined : () => diagnose('discover')}
                    />
                  ) : null}
                </SettingsSection>
                <SectionFooter>
                  Checks use the key above without saving it. Text checks send a short test prompt
                  and may cost a little; transcription checks only confirm access to the model list.
                </SectionFooter>
                <View className="mx-4 mb-7">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canSave, busy }}
                    onPress={save}
                    disabled={!canSave}
                    className={
                      'items-center rounded-[10px] py-3 ' + (canSave ? 'bg-brand' : 'bg-brand/30')
                    }
                    style={({ pressed }) => ({
                      borderCurve: 'continuous',
                      opacity: pressed ? 0.85 : 1,
                      transform: [{ scale: pressed ? 0.98 : 1 }],
                    })}
                  >
                    {busy && !checking ? (
                      <ActivityIndicator color="white" />
                    ) : (
                      <Text className="text-[15px] font-semibold text-white">Save</Text>
                    )}
                  </Pressable>
                </View>
              </>
            ) : null}
            {scope === 'notes' ? <NoteTitleSettings /> : null}
          </>
        )}
      </SettingsScreen>
      <Toast {...toast} topOffset={headerHeight + 8} />
    </View>
  );
}
