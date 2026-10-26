import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { AudioLines, Check, CircleCheck, MousePointer2 } from "../icons";
import { useTranslation } from "react-i18next";
import { FieldLabel, ProviderCheckField } from "../ui/ProviderCheckField";
import { ConnectionCheckAnnouncer } from "../ui/ConnectionCheckAnnouncer";
import { Button } from "../ui/button";
import { ProviderIcon } from "../ui/ProviderIcon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { useConnectionAutoCheck } from "../../hooks/useConnectionAutoCheck";
import { isWindowSwitchBlur } from "../../hooks/useFocusHold";
import { useSettingsStore } from "../../stores/settingsStore";
import { normalizeBaseUrl } from "../../config/constants";
import { withHttpsScheme } from "../../utils/urlUtils";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import {
  filterByokProviderOptionsByPolicy,
  isModeAllowedByPolicy,
  isProviderAllowedByPolicy,
} from "../../stores/policyRules";
import {
  getTranscriptionProviders,
  modelRegistry,
  type CloudProviderData,
  type TranscriptionProviderData,
} from "../../models/ModelRegistry";
import { pickDefaultModelId } from "../../models/providerDefaultModel";
import {
  RESUME_DRAFT_PERSIST_DELAY_MS,
  type OnboardingByokDraft,
  type OnboardingStepId,
} from "./flow";
import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import { isBlankByokDraft, resolveSavedByokConfig } from "./savedByokConfig";

export function SetupStageStepper({ stepId }: { stepId: OnboardingStepId }) {
  const { t } = useTranslation();
  const assistant = stepId.endsWith("assistant");
  return (
    <div
      className="relative mx-auto flex items-start justify-between w-40"
      aria-label={t("onboarding.rehaul.provider.progress")}
    >
      <span className="absolute left-8 right-8 border-t border-dashed border-[var(--onboarding-control-border)] top-4" />
      <div className="relative z-10 flex w-14 flex-col items-center gap-1.5 text-[var(--onboarding-text-secondary)]">
        <span
          className={`flex items-center justify-center rounded-full size-8 ${
            assistant
              ? "bg-[var(--onboarding-accent)] text-[var(--onboarding-accent-foreground)]"
              : "bg-[var(--onboarding-inverse-surface)] text-[var(--onboarding-inverse-text)]"
          }`}
        >
          {assistant ? (
            <CircleCheck className="size-4" strokeWidth={2} />
          ) : (
            <AudioLines className="size-4" />
          )}
        </span>
        <span className="text-xs">{t("onboarding.rehaul.provider.dictation")}</span>
      </div>
      <div className="relative z-10 flex w-14 flex-col items-center gap-1.5 text-[var(--onboarding-text-secondary)]">
        <span
          className={`flex items-center justify-center rounded-full size-8 ${
            assistant
              ? "bg-[var(--onboarding-inverse-surface)] text-[var(--onboarding-inverse-text)]"
              : "border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] text-[var(--onboarding-text-primary)]"
          }`}
        >
          <MousePointer2 className="size-4" />
        </span>
        <span className="text-xs">{t("onboarding.rehaul.provider.assistant")}</span>
      </div>
    </div>
  );
}

/**
 * The card action runs on the same pill as the shell footer's primary (Figma
 * "Frame 25"): 40 tall, radius 38, Inter Medium 14/140%, on the onboarding
 * accent. Before this, each card carried its own hand-rolled
 * 32px-tall button — some on blue-500, some on neutral-950, all at regular
 * weight — so the step's own call to action read quieter than the Continue
 * button sitting right under it.
 */
function StepPrimaryAction({
  onClick,
  disabled = false,
  className = "",
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`h-9 rounded-[38px] px-5 text-sm ${className}`}
    >
      {children}
    </Button>
  );
}

/** The card each setup mode's step renders into. Top margin is per call site. */
const SETUP_CARD_BASE_CLASS =
  "mx-auto w-full rounded-[1.125rem] border border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] text-[var(--onboarding-text-primary)]";

export const SETUP_CARD_CLASS = `${SETUP_CARD_BASE_CLASS} max-w-[30rem] px-3 py-4`;

/** The field trigger. Call sites that can be disabled add the disabled: variants. */
const SELECT_TRIGGER_CLASS =
  "h-9 rounded-xl border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface-secondary)] px-3 text-xs text-[var(--onboarding-text-primary)]";

/**
 * The dropdown sheet, Figma "Onboarding / Frame 16": radius 17 on
 * light/surface-stroke, 12 pad, `0 3 7.3 #0000001F` shadow. Radix's viewport
 * carries its own 4px pad, which would stack with the panel's — zero it and let
 * the panel own the inset, so the rows run edge to edge inside it and the
 * scrollbar (styled in index.css) sits in the panel's gutter.
 *
 * The 12 of inset is split 6 here and 6 on the row, the same way
 * .onboarding-list-scroll splits its 4 with .onboarding-list-row: labels still
 * land 12 from the panel edge, and the 6 is the breathing room the row's hover
 * slab needs so it reads as a slab and not as a full-bleed band. Vertical drops
 * to 8 because the rows keep their own 12 at the ends now (see below).
 *
 * Every colour here is an --onboarding-* token rather than a literal, which is
 * what lets the panel follow the theme from out here: it portals to document.body,
 * outside .onboarding-canvas, and the token block in index.css is scoped to
 * `body:has(.onboarding-canvas)` for exactly this case. It used to carry `dark:`
 * copies of the light values instead, to pin the sheet light while onboarding was
 * light-only.
 */
const SELECT_PANEL_CLASS =
  "onboarding-select-panel rounded-[17px] border-[var(--onboarding-control-border)] bg-[var(--onboarding-surface)] px-1.5 py-2 text-[var(--onboarding-text-primary)] shadow-[0_3px_7.3px_0_rgba(0,0,0,0.12)] [&_[data-radix-select-viewport]]:p-0";

/**
 * A row from the same frame: 12 of vertical padding, 20px mark at gap 10, label
 * Inter Medium 16/140%.
 *
 * The dividers and the rounded hover slab live in `.onboarding-select-item`
 * (index.css) so they can behave the way .onboarding-list-row's do — hairlines
 * separate rows rather than bounding them, and a hovered row's slab swallows its
 * own rule and the next one's. Unlike the old `first:pt-0 last:pb-0`, the end rows
 * keep their padding: dropping it would leave the first and last slab shorter than
 * every other one. The panel's vertical inset absorbs that instead.
 *
 * The bg-transparent variants neutralise the base SelectItem's theme-bound fills
 * (`hover:bg-muted`, `dark:hover:bg-primary/8`), which resolve against the app
 * theme out here and would paint a square band behind the slab.
 */
const SELECT_ITEM_CLASS =
  "onboarding-select-item gap-2.5 rounded-none py-2.5 ps-1.5 pe-8 text-sm font-normal leading-[1.4] hover:bg-transparent focus:bg-transparent data-highlighted:bg-transparent dark:hover:bg-transparent dark:focus:bg-transparent dark:data-highlighted:bg-transparent [&>span:nth-child(2)]:w-full";

function providerCredential(provider: string, store: ReturnType<typeof useSettingsStore.getState>) {
  switch (provider) {
    case "openai":
      return { value: store.openaiApiKey, set: store.setOpenaiApiKey };
    case "anthropic":
      return { value: store.anthropicApiKey, set: store.setAnthropicApiKey };
    case "gemini":
      return { value: store.geminiApiKey, set: store.setGeminiApiKey };
    case "groq":
      return { value: store.groqApiKey, set: store.setGroqApiKey };
    case "xai":
      return { value: store.xaiApiKey, set: store.setXaiApiKey };
    case "mistral":
      return { value: store.mistralApiKey, set: store.setMistralApiKey };
    case "openrouter":
      return { value: store.openrouterApiKey, set: store.setOpenrouterApiKey };
    case "tinfoil":
      return { value: store.tinfoilApiKey, set: store.setTinfoilApiKey };
    case "corti":
      return { value: store.cortiApiKey, set: store.setCortiApiKey };
    case "deepgram":
      return { value: store.deepgramApiKey, set: store.setDeepgramApiKey };
    case "assemblyai":
      return { value: store.assemblyaiApiKey, set: store.setAssemblyaiApiKey };
    default:
      return { value: "", set: (_value: string) => undefined };
  }
}

/**
 * One server's variants — missing scheme, host case, trailing slash, pasted API path —
 * compare equal. Parsing lowercases the scheme and host; the path keeps its case.
 */
function endpointIdentity(baseUrl: string): string {
  const normalized = normalizeBaseUrl(withHttpsScheme(baseUrl));
  try {
    return new URL(normalized).href;
  } catch {
    return normalized;
  }
}

function isSameEndpoint(baseUrl: string, savedBaseUrl: string): boolean {
  const saved = endpointIdentity(savedBaseUrl);
  return Boolean(saved) && endpointIdentity(baseUrl) === saved;
}

type HostedProvider = CloudProviderData | TranscriptionProviderData;

export function ByokProviderStep({
  stepId,
  selfHostedRequested = false,
  onSelfHostedChange,
  onConnectionChange,
  onProceed,
  resumeState,
  onResumeStateChange,
}: {
  stepId: "byok-dictation" | "byok-assistant";
  /** Set when the user picked "Self-hosted" on setup-choice rather than BYOK. */
  selfHostedRequested?: boolean;
  onSelfHostedChange: (requested: boolean) => void;
  onConnectionChange: (usable: boolean) => void;
  onProceed: () => void;
  resumeState?: OnboardingByokDraft;
  onResumeStateChange?: (state: OnboardingByokDraft) => void;
}) {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const policy = usePolicySnapshot();
  const assistant = stepId === "byok-assistant";
  const scope = assistant ? "llm" : "transcription";
  const selfHostedAllowed =
    isModeAllowedByPolicy(policy, scope, "self-hosted") &&
    isProviderAllowedByPolicy(policy, scope, "custom");
  const providers = useMemo(
    () =>
      filterByokProviderOptionsByPolicy<HostedProvider>(
        assistant ? modelRegistry.getCloudProviders() : getTranscriptionProviders(),
        scope,
        policy
      ),
    [assistant, policy, scope]
  );
  // The session's draft wins; without one (onboarding was restarted, or an older build
  // left it blank) the step reopens on what the user already saved. The draft never
  // records keys, so the stored custom key is tracked by the endpoint it was saved
  // under — the draft, and anything typed after it, can name a different server than
  // the saved settings do.
  const [seed] = useState(() => {
    const saved = resolveSavedByokConfig(stepId, store);
    const hasDraft = Boolean(resumeState && !isBlankByokDraft(resumeState));
    const draft = hasDraft ? resumeState : saved?.draft;
    const providerData = providers.find((provider) => provider.id === draft?.selectedProvider);
    // After a restart the session only knows which setup-choice tile was clicked, so a
    // saved endpoint opens its own card whichever tile that was; a draft carries the
    // card the session recorded for it.
    const selfHostedWanted =
      hasDraft || !saved ? selfHostedRequested : Boolean(saved.draft.baseUrl);
    const selfHosted = selfHostedWanted && selfHostedAllowed;
    return {
      provider: providerData?.id ?? "",
      model: providerData?.models?.some((model) => model.id === draft?.selectedModel)
        ? (draft?.selectedModel ?? "")
        : pickDefaultModelId(providerData),
      baseUrl: draft?.baseUrl ?? "",
      customModel: draft?.customModel ?? "",
      selfHosted,
      cardDiffersFromSession: selfHosted !== selfHostedRequested,
      keyedBaseUrl: saved?.usesCustomKey ? saved.draft.baseUrl : "",
    };
  });
  // Hosted and self-hosted share the key field, so each mode shows its own saved key.
  // The stored custom key belongs to the one endpoint it was saved under: offering it for
  // a key-less server, a hosted provider, a first setup, or an endpoint the user has since
  // typed would send a key they never typed to that server, and move the save onto the
  // keyed route.
  const credentialFor = (selfHostedMode: boolean, providerId: string, baseUrl: string) => {
    if (!selfHostedMode) return providerCredential(providerId, store).value;
    if (!isSameEndpoint(baseUrl, seed.keyedBaseUrl)) return "";
    return assistant ? store.chatAgentCustomApiKey : store.customTranscriptionApiKey;
  };
  const [selfHosted, setSelfHosted] = useState(seed.selfHosted);
  const [selectedProvider, setSelectedProvider] = useState(seed.provider);
  const [selectedModel, setSelectedModel] = useState(seed.model);
  const [draftApiKey, setDraftApiKey] = useState(() =>
    credentialFor(seed.selfHosted, seed.provider, seed.baseUrl)
  );
  const [draftBaseUrl, setDraftBaseUrl] = useState(seed.baseUrl);
  const [draftCustomModel, setDraftCustomModel] = useState(seed.customModel);
  const [draftCortiClientId, setDraftCortiClientId] = useState(
    seed.provider === "corti" ? store.cortiClientId : ""
  );
  const [draftCortiClientSecret, setDraftCortiClientSecret] = useState(
    seed.provider === "corti" ? store.cortiClientSecret : ""
  );
  const [endpointFocused, setEndpointFocused] = useState(false);

  // The card the saved setup picked goes on the session once, at mount (both deps are
  // stable), so the draft this visit writes reopens on it; later switches report
  // through toggleSelfHosted.
  useEffect(() => {
    if (seed.cardDiffersFromSession) onSelfHostedChange(seed.selfHosted);
  }, [onSelfHostedChange, seed]);

  // Base URL and custom model are typed, so the write is debounced the way the
  // auth draft is; the flush covers the pending write this card drops when the
  // step advances and unmounts it.
  const latestByokDraft = useRef<OnboardingByokDraft | null>(null);
  const flushByokDraft = useCallback(() => {
    if (latestByokDraft.current) onResumeStateChange?.(latestByokDraft.current);
  }, [onResumeStateChange]);
  const persistByokDraft = useDebouncedCallback(flushByokDraft, RESUME_DRAFT_PERSIST_DELAY_MS);

  useEffect(() => {
    latestByokDraft.current = {
      selectedProvider,
      selectedModel,
      baseUrl: draftBaseUrl,
      customModel: draftCustomModel,
    };
    persistByokDraft();
  }, [draftBaseUrl, draftCustomModel, persistByokDraft, selectedModel, selectedProvider]);

  useEffect(() => flushByokDraft, [flushByokDraft]);

  // A live policy update can remove self-hosting while this card is open. The hosted
  // half of the form is kept, so it only needs its provider's key.
  useEffect(() => {
    if (!selfHosted || selfHostedAllowed) return;
    setSelfHosted(false);
    onSelfHostedChange(false);
    setDraftApiKey(providerCredential(selectedProvider, useSettingsStore.getState()).value);
  }, [onSelfHostedChange, selectedProvider, selfHosted, selfHostedAllowed]);

  // Saved keys load asynchronously (initializeSettings), so an empty field takes its key
  // when it arrives; anything already in the field is kept.
  const savedKey = credentialFor(selfHosted, selectedProvider, draftBaseUrl);
  // Retyping the endpoint strands the copy of the stored key this card prefilled, so it is
  // taken back out. Only a byte-identical copy goes — never a key the user typed, and
  // never while the field still names the endpoint the key was saved under.
  const strandedKey =
    selfHosted && !savedKey
      ? assistant
        ? store.chatAgentCustomApiKey
        : store.customTranscriptionApiKey
      : "";
  const savedCortiClientId = selectedProvider === "corti" ? store.cortiClientId : "";
  const savedCortiClientSecret = selectedProvider === "corti" ? store.cortiClientSecret : "";
  useEffect(() => {
    if (savedKey) setDraftApiKey((current) => current || savedKey);
    else if (strandedKey) setDraftApiKey((current) => (current === strandedKey ? "" : current));
    if (savedCortiClientId) setDraftCortiClientId((current) => current || savedCortiClientId);
    if (savedCortiClientSecret) {
      setDraftCortiClientSecret((current) => current || savedCortiClientSecret);
    }
  }, [savedCortiClientId, savedCortiClientSecret, savedKey, strandedKey]);

  const currentProvider = providers.find((provider) => provider.id === selectedProvider);
  const models = currentProvider?.models ?? [];
  const knownCredential = providerCredential(selectedProvider, store);
  // Both halves of the form survive a mode switch, so switching back shows the saved or
  // typed values again; only the shared key field follows the mode.
  const toggleSelfHosted = () => {
    const next = !selfHosted;
    setSelfHosted(next);
    onSelfHostedChange(next);
    setDraftApiKey(credentialFor(next, selectedProvider, draftBaseUrl));
    setEndpointFocused(false); // the address field leaves with its card, sometimes without a blur
  };

  const chooseProvider = (providerId: string) => {
    const fallbackModel = pickDefaultModelId(providers.find((item) => item.id === providerId));
    setSelectedProvider(providerId);
    setSelectedModel(fallbackModel);
    setDraftApiKey(providerCredential(providerId, store).value);
    setDraftCortiClientId(providerId === "corti" ? store.cortiClientId : "");
    setDraftCortiClientSecret(providerId === "corti" ? store.cortiClientSecret : "");
  };

  const testingProvider = selfHosted ? "custom" : selectedProvider;
  const testingKey = draftApiKey;
  const testingBaseUrl = selfHosted ? draftBaseUrl : undefined;
  const isCortiTranscription = !assistant && !selfHosted && selectedProvider === "corti";
  // A provider counts only while policy still lists it: a policy that loads after mount
  // can remove the one this card opened on.
  const fieldsReady = selfHosted
    ? Boolean(draftBaseUrl.trim() && draftCustomModel.trim())
    : isCortiTranscription
      ? Boolean(
          currentProvider &&
          draftCortiClientId.trim() &&
          draftCortiClientSecret.trim() &&
          selectedModel
        )
      : Boolean(currentProvider && selectedModel && testingKey.trim());

  const check = useConnectionAutoCheck({
    config: {
      scope: assistant ? "reasoning" : "transcription",
      provider: testingProvider,
      apiKey: testingKey,
      baseUrl: testingBaseUrl,
      model: selfHosted ? draftCustomModel : selectedModel,
      clientId: isCortiTranscription ? draftCortiClientId : undefined,
      clientSecret: isCortiTranscription ? draftCortiClientSecret : undefined,
      environment: store.cortiEnvironment,
      tenant: store.cortiTenant,
    },
    ready: fieldsReady,
    // A half-typed address may belong to someone else: nothing is sent while it is edited.
    hold: selfHosted && endpointFocused,
  });
  // A provider that gave no verdict (busy, slow or unreachable) refused nothing, so its
  // setup can be used; only a failure that faults it keeps Proceed locked.
  const usable = check.phase === "connected" || check.phase === "unverified";
  useEffect(() => {
    onConnectionChange(usable);
  }, [usable, onConnectionChange]);

  // Switching to another app blurs the field but leaves it focused in the page, and the
  // address there may still be half typed.
  const releaseEndpoint = (event: FocusEvent<HTMLInputElement>) => {
    if (!isWindowSwitchBlur(event)) setEndpointFocused(false);
  };

  const commitAndProceed = () => {
    if (selfHosted) {
      const committedBaseUrl = withHttpsScheme(draftBaseUrl);
      if (assistant) {
        store.setChatAgentRemoteUrl(committedBaseUrl);
        store.setChatAgentCustomApiKey(draftApiKey);
        store.setChatAgentModel(draftCustomModel);
        store.setChatAgentMode("self-hosted");
        store.setChatAgentProvider("custom");
      } else if (draftApiKey.trim()) {
        store.setCloudTranscriptionBaseUrl(committedBaseUrl);
        store.setCustomTranscriptionApiKey(draftApiKey);
        // Switch before setting the model: a switch files the current model under the
        // outgoing provider and loads the incoming one's, replacing what was typed here.
        store.switchCloudTranscriptionProvider("dictation", "custom");
        store.setCloudTranscriptionModel(draftCustomModel);
        // A Settings server routes ahead of the keyed Custom endpoint, and sends no key.
        store.setRemoteTranscriptionUrl("");
        store.setCloudTranscriptionMode("byok");
      } else {
        // Key-less, so it is the Settings self-hosted server; the Custom endpoint and its
        // key stay as they were. byok + custom is what derives the self-hosted mode.
        store.switchCloudTranscriptionProvider("dictation", "custom");
        store.setRemoteTranscriptionUrl(committedBaseUrl);
        store.setRemoteTranscriptionModel(draftCustomModel);
        store.setRemoteTranscriptionType("openai-compatible");
        store.setCloudTranscriptionMode("byok");
      }
    } else if (assistant) {
      knownCredential.set(draftApiKey);
      store.setChatAgentMode("providers");
      store.switchReasoningProvider("chatIntelligence", selectedProvider, selectedModel);
      store.setChatAgentModel(selectedModel);
    } else {
      if (isCortiTranscription) {
        store.setCortiClientId(draftCortiClientId);
        store.setCortiClientSecret(draftCortiClientSecret);
      } else {
        knownCredential.set(draftApiKey);
      }
      store.setCloudTranscriptionMode("byok");
      store.switchCloudTranscriptionProvider("dictation", selectedProvider);
      store.setCloudTranscriptionModel(selectedModel);
    }
    onProceed();
  };

  return (
    <section className={`mt-5 ${SETUP_CARD_CLASS}`}>
      <SetupStageStepper stepId={stepId} />

      <div className="mt-3 space-y-3">
        {selfHostedAllowed && (
          <button
            type="button"
            role="checkbox"
            aria-checked={selfHosted}
            onClick={toggleSelfHosted}
            className="flex items-center gap-2 text-xs text-[var(--onboarding-text-primary)]"
          >
            {/* Matches the checkbox in LanguageSelectionStep, which was built from
                the spec: the light stroke stays on in both states, the fill is the
                accent token rather than blue-500, and the tick is hairline. Kept at
                size-5 because this card is the denser text-xs layout. */}
            <span
              className={`flex size-5 shrink-0 items-center justify-center rounded-[5.5px] border border-[var(--onboarding-control-border)] ${
                selfHosted
                  ? "bg-[var(--onboarding-accent)] text-[var(--onboarding-accent-foreground)]"
                  : "bg-[var(--onboarding-surface)]"
              }`}
              aria-hidden="true"
            >
              {selfHosted && <Check className="size-3.5" strokeWidth={1.17} />}
            </span>
            {t("onboarding.rehaul.provider.selfHosted")}
          </button>
        )}

        {selfHosted ? (
          <>
            <ProviderCheckField
              label={t("onboarding.rehaul.provider.endpointUrl")}
              value={draftBaseUrl}
              onChange={(event) => setDraftBaseUrl(event.target.value)}
              onFocus={() => setEndpointFocused(true)}
              onBlur={releaseEndpoint}
              placeholder={t("onboarding.rehaul.provider.endpointPlaceholder")}
            />
            <ProviderCheckField
              label={t("onboarding.rehaul.provider.apiKey")}
              type="password"
              value={draftApiKey}
              onChange={(event) => setDraftApiKey(event.target.value)}
              placeholder={t("onboarding.rehaul.provider.optional")}
              autoComplete="off"
              spellCheck={false}
            />
            <ProviderCheckField
              label={t("onboarding.rehaul.provider.modelId")}
              check={check}
              invalidOn="modelNotFound"
              value={draftCustomModel}
              onChange={(event) => setDraftCustomModel(event.target.value)}
              placeholder={t("onboarding.rehaul.provider.modelIdPlaceholder")}
            />
          </>
        ) : (
          <>
            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.providerLabel")}</FieldLabel>
              <Select value={selectedProvider || undefined} onValueChange={chooseProvider}>
                <SelectTrigger
                  className={`${SELECT_TRIGGER_CLASS} disabled:opacity-100 disabled:[&>svg]:hidden`}
                >
                  {currentProvider ? (
                    <div className="flex items-center gap-2">
                      <ProviderIcon provider={currentProvider.id} className="size-4" />
                      {currentProvider.name}
                    </div>
                  ) : (
                    <span className="text-[var(--onboarding-text-secondary)]">
                      {t("onboarding.rehaul.provider.providerPlaceholder")}
                    </span>
                  )}
                </SelectTrigger>
                <SelectContent className={`max-h-[14.625rem] ${SELECT_PANEL_CLASS}`}>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id} className={SELECT_ITEM_CLASS}>
                      <span className="flex items-center gap-2.5">
                        <ProviderIcon provider={provider.id} className="size-5" />
                        <span>{provider.name}</span>
                        {provider.id === "corti" && (
                          <span className="ms-auto rounded bg-[color-mix(in_srgb,var(--onboarding-accent)_12%,transparent)] px-2 py-1 text-[0.625rem] text-[var(--onboarding-accent)]">
                            {t("onboarding.rehaul.provider.clinical")}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="block">
              <FieldLabel>{t("onboarding.rehaul.provider.modelLabel")}</FieldLabel>
              <Select
                value={selectedModel || undefined}
                onValueChange={setSelectedModel}
                disabled={!selectedProvider}
              >
                <SelectTrigger
                  className={`${SELECT_TRIGGER_CLASS} disabled:opacity-100 disabled:[&>svg]:hidden`}
                >
                  {selectedModel ? (
                    <span dir="ltr">
                      {models.find((model) => model.id === selectedModel)?.name ?? selectedModel}
                    </span>
                  ) : (
                    <span className="text-[var(--onboarding-text-secondary)]">
                      {t("onboarding.rehaul.provider.modelPlaceholder")}
                    </span>
                  )}
                </SelectTrigger>
                <SelectContent className={`max-h-[14.625rem] ${SELECT_PANEL_CLASS}`}>
                  {models.map((model) => (
                    <SelectItem key={model.id} value={model.id} className={SELECT_ITEM_CLASS}>
                      {model.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            {isCortiTranscription ? (
              <div className="grid grid-cols-2 gap-2">
                <ProviderCheckField
                  label={t("onboarding.rehaul.provider.clientId")}
                  value={draftCortiClientId}
                  onChange={(event) => setDraftCortiClientId(event.target.value)}
                  autoComplete="off"
                />
                <ProviderCheckField
                  label={t("onboarding.rehaul.provider.clientSecret")}
                  check={check}
                  invalidOn="credentialsRejected"
                  type="password"
                  value={draftCortiClientSecret}
                  onChange={(event) => setDraftCortiClientSecret(event.target.value)}
                  autoComplete="off"
                />
              </div>
            ) : (
              <ProviderCheckField
                label={t("onboarding.rehaul.provider.apiKey")}
                check={check}
                invalidOn="credentialsRejected"
                type="password"
                value={draftApiKey}
                onChange={(event) => setDraftApiKey(event.target.value)}
                placeholder={t("onboarding.rehaul.provider.apiKeyPlaceholder")}
                disabled={!selectedProvider}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </>
        )}

        <StepPrimaryAction onClick={commitAndProceed} disabled={!usable} className="mt-4! w-full">
          {t("onboarding.rehaul.provider.proceed")}
        </StepPrimaryAction>
      </div>

      <ConnectionCheckAnnouncer announcement={check.announcement} />
    </section>
  );
}
