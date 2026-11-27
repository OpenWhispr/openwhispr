import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import ModelCardList from "./ui/ModelCardList";
import SearchableModelList, { MODEL_SEARCH_THRESHOLD } from "./ui/SearchableModelList";
import { buildApiUrl, getModelListBaseCandidates, normalizeBaseUrl } from "../config/constants";
import { isSecureHttpEndpoint } from "../utils/urlUtils";
import { resolveApiKey } from "../utils/resolveApiKey";
import { GetApiKeyLink } from "./ui/GetApiKeyLink";
import { ConnectionCheckAnnouncer } from "./ui/ConnectionCheckAnnouncer";
import { ProviderCheckField } from "./ui/ProviderCheckField";
import SecretRefErrorText from "./ui/SecretRefErrorText";
import { usePanelVisible } from "./ui/usePanelVisible";
import { isWindowSwitchBlur, useFocusHold } from "../hooks/useFocusHold";
import { useConnectionAutoCheck } from "../hooks/useConnectionAutoCheck";
import { credentialDraftRefused, useCredentialDraft } from "../hooks/useCredentialDraft";
import { useTypingPause } from "../hooks/useTypingPause";
import { offersOpenRouterModel, openRouterModelList } from "../utils/openRouterModels";
import type { ModelCapability } from "../config/inferenceScopes";

interface ModelOption {
  value: string;
  label: string;
  description?: string;
  ownedBy?: string;
  eligibleForScope: boolean;
}

interface OpenAICompatiblePanelProps {
  baseUrl: string;
  setBaseUrl: (value: string) => void;
  apiKey: string;
  setApiKey: (value: string) => void;
  model: string;
  setModel: (value: string) => void;
  defaultBaseUrl?: string;
  baseUrlPlaceholder?: string;
  helpExamples?: ReactNode;
  // Hide the endpoint editor when the URL is fixed by the caller (e.g. OpenRouter).
  lockedBaseUrl?: boolean;
  // Providers whose /models is public but whose inference needs a key.
  apiKeyRequired?: boolean;
  getKeyUrl?: string;
  // The connection the panel checks: the user's own server, or OpenRouter.
  provider?: "custom" | "openrouter";
  // What the scope's requests need; OpenRouter's list leaves out models without it.
  modelNeeds?: readonly ModelCapability[];
}

export default function OpenAICompatiblePanel({
  baseUrl,
  setBaseUrl,
  apiKey: savedApiKey,
  setApiKey,
  model,
  setModel,
  defaultBaseUrl,
  baseUrlPlaceholder = "https://api.openai.com/v1",
  helpExamples,
  lockedBaseUrl = false,
  apiKeyRequired = false,
  getKeyUrl,
  provider = "custom",
  modelNeeds,
}: OpenAICompatiblePanelProps) {
  const { t } = useTranslation();
  const [draftBase, setDraftBase] = useState(baseUrl);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const lastLoadedBaseRef = useRef<string | null>(null);
  const lastLoadedKeyRef = useRef<string | null>(null);
  const lastLoadedRevisionRef = useRef(0);
  const pendingLoadRef = useRef<{ base: string } | null>(null);
  const latestBaseRef = useRef<string>(normalizeBaseUrl(baseUrl));
  const keyDraft = useCredentialDraft();
  const apiKey = keyDraft.value("apiKey", savedApiKey);
  // OpenRouter's tested list supplies the recommendation ranking for this scope.
  const testedModels = provider === "openrouter" ? openRouterModelList(modelNeeds) : null;
  // The list reads the key, the model and the address setter through refs, so neither a key
  // change, a pick nor a parent's new setter on each render reloads it.
  const apiKeyRef = useRef(apiKey);
  const modelRef = useRef(model);
  const setBaseUrlRef = useRef(setBaseUrl);
  useEffect(() => {
    apiKeyRef.current = apiKey;
    modelRef.current = model;
    setBaseUrlRef.current = setBaseUrl;
  }, [apiKey, model, setBaseUrl]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setDraftBase(baseUrl);
  }, [baseUrl]);

  const normalizedBase = useMemo(() => normalizeBaseUrl(baseUrl), [baseUrl]);
  const visible = usePanelVisible();
  const editing = useFocusHold();
  // An address with no http:// or https:// is left to the model list, which says so.
  const checkReady =
    provider === "openrouter" ? Boolean(apiKey.trim()) : normalizedBase.includes("://");
  // The address applies when its field is left, so it is never half-typed here.
  const delayMs = useTypingPause({
    typed: apiKey,
    context: JSON.stringify([provider, normalizedBase, model, visible]),
    held: editing.held,
  });
  const check = useConnectionAutoCheck({
    // The model is this panel's own (or "" under a tab that is only browsed), so a saved model
    // the server no longer lists fails as modelNotFound.
    config: { scope: "reasoning", provider, baseUrl: normalizedBase, apiKey, model },
    // A hidden panel is not ready to ask; a shown one asks again, and the main process answers
    // a check it remembers at once.
    ready: checkReady && visible,
    delayMs,
  });
  const revisionRef = useRef(check.credentialRevision);
  useEffect(() => {
    revisionRef.current = check.credentialRevision;
  }, [check.credentialRevision]);
  const followKeyDraft = keyDraft.follow;
  const refused = credentialDraftRefused(provider, check.failure?.errorCode);
  useEffect(() => {
    followKeyDraft({
      phase: check.phase,
      checked: { apiKey },
      refused,
      credentialRevision: check.credentialRevision,
    });
  }, [check.phase, check.credentialRevision, apiKey, refused, followKeyDraft]);

  useEffect(() => {
    latestBaseRef.current = normalizedBase;
  }, [normalizedBase]);

  const hasBase = normalizedBase !== "";
  const trimmedDraft = draftBase.trim();
  const hasSavedBase = Boolean((baseUrl || "").trim());
  const isDraftDirty = trimmedDraft !== (baseUrl || "").trim();
  // The status describes the applied address, so it waits while another one is typed.
  const endpointCheck = isDraftDirty ? { ...check, phase: "idle" as const, failure: null } : check;
  const failureReason =
    !apiKey.trim() && check.failure?.errorCode === "credentialsRejected"
      ? t("reasoning.custom.endpointUnauthorized")
      : undefined;
  // While the check covers the address, its reason under the field replaces the list's line.
  const listErrorShown =
    Boolean(modelsError) && (lockedBaseUrl || !checkReady || check.phase === "connected");
  const keyLabel = t(apiKeyRequired ? "common.apiKey" : "reasoning.custom.apiKeyOptional");

  const loadRemoteModels = useCallback(
    async (baseOverride?: string, force = false) => {
      const rawBase = (baseOverride ?? baseUrl) || "";
      const normalized = normalizeBaseUrl(rawBase);

      if (!normalized) {
        if (isMountedRef.current) {
          setModelsLoading(false);
          setModelsError(null);
          setModelOptions([]);
        }
        return;
      }

      if (!force && lastLoadedBaseRef.current === normalized) return;
      if (!force && pendingLoadRef.current?.base === normalized) return;

      if (baseOverride !== undefined) {
        latestBaseRef.current = normalized;
      }

      const request = { base: normalized };
      pendingLoadRef.current = request;

      // Keep the previous list visible while refreshing so the searchable list
      // (and its query state) isn't unmounted mid-fetch.
      if (isMountedRef.current) {
        setModelsLoading(true);
        setModelsError(null);
      }

      const trimmedKey = apiKeyRef.current.trim();
      // The field keeps a $VAR reference as typed; only the request gets its expansion.
      const sourceRevision = revisionRef.current;
      lastLoadedRevisionRef.current = sourceRevision;
      lastLoadedKeyRef.current = trimmedKey;
      const resolvedKey = await resolveApiKey(trimmedKey);
      const effectiveKey = resolvedKey.length > 0 ? resolvedKey : undefined;
      const isCurrent = (): boolean =>
        isMountedRef.current &&
        pendingLoadRef.current === request &&
        latestBaseRef.current === normalized &&
        apiKeyRef.current.trim() === trimmedKey &&
        revisionRef.current === sourceRevision;

      try {
        if (!isCurrent()) return;
        if (!normalized.includes("://")) {
          setModelsError(t("reasoning.custom.endpointWithProtocol"));
          return;
        }

        if (!isSecureHttpEndpoint(normalized)) {
          setModelsError(t("reasoning.custom.httpsRequired"));
          return;
        }

        const headers: Record<string, string> = {};
        if (trimmedKey && !effectiveKey) {
          throw new Error(t("onboarding.rehaul.provider.errors.secretRefUnset"));
        }
        if (effectiveKey) {
          headers.Authorization = `Bearer ${effectiveKey}`;
        }

        const fetchModelOptions = async (base: string): Promise<ModelOption[]> => {
          const response = await fetch(buildApiUrl(base, "/models"), { method: "GET", headers });

          if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            const summary = errorText
              ? `${response.status} ${errorText.slice(0, 200)}`
              : `${response.status} ${response.statusText}`;
            throw new Error(summary.trim());
          }

          const payload = await response.json().catch(() => ({}));
          const rawModels = Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.models)
              ? payload.models
              : [];

          const options = (rawModels as Array<Record<string, unknown>>)
            .map((item): ModelOption | null => {
              // Coerce fields defensively: non-conformant endpoints may return
              // numeric ids or object descriptions, which would crash the render.
              const rawValue = item?.id ?? item?.name;
              if (rawValue === undefined || rawValue === null || rawValue === "") return null;
              const value = String(rawValue);
              const ownedBy = typeof item?.owned_by === "string" ? item.owned_by : undefined;
              const description =
                typeof item?.description === "string" && item.description
                  ? item.description
                  : ownedBy
                    ? t("reasoning.custom.ownerLabel", { owner: ownedBy })
                    : undefined;
              return {
                value,
                label: value,
                description,
                ownedBy,
                eligibleForScope:
                  provider !== "openrouter" || offersOpenRouterModel(item, modelNeeds),
              };
            })
            .filter(
              (option): option is ModelOption =>
                option !== null && (option.eligibleForScope || option.value === modelRef.current)
            );
          // A saved pick that is off the list ranks -1, so it leads.
          return testedModels
            ? options.sort((a, b) => testedModels.indexOf(a.value) - testedModels.indexOf(b.value))
            : options;
        };

        // When the entered base yields no models, fall back through sibling
        // bases and adopt the working one so inference targets it too.
        const candidates = lockedBaseUrl ? [normalized] : getModelListBaseCandidates(normalized);
        let mapped: ModelOption[] = [];
        let resolvedBase = normalized;
        let primaryError: Error | null = null;

        for (const candidate of candidates) {
          if (!isCurrent()) return;
          try {
            const options = await fetchModelOptions(candidate);
            if (options.length > 0) {
              mapped = options;
              resolvedBase = candidate;
              break;
            }
          } catch (error) {
            if (candidate === normalized) primaryError = error as Error;
          }
        }

        if (mapped.length === 0 && primaryError) throw primaryError;

        if (isCurrent()) {
          if (resolvedBase !== normalized) {
            latestBaseRef.current = resolvedBase;
            setDraftBase(resolvedBase);
            setBaseUrlRef.current(resolvedBase);
          }
          setModelOptions(mapped);
          // `/models` is a discovery aid, not an allowlist — keep the user's
          // chosen id even if it's absent (it may still be valid, or belong to
          // a provider they're switching away from). Invalid ids surface a
          // clear API error at request time instead of being silently wiped.
          setModelsError(null);
          lastLoadedBaseRef.current = resolvedBase;
        }
      } catch (error) {
        if (isCurrent()) {
          lastLoadedBaseRef.current = null;
          const message = (error as Error).message || t("reasoning.custom.unableToLoadModels");
          const unauthorized = /\b(401|403)\b/.test(message);
          if (unauthorized && !effectiveKey) {
            setModelsError(t("reasoning.custom.endpointUnauthorized"));
          } else {
            setModelsError(message);
          }
          setModelOptions([]);
        }
      } finally {
        if (pendingLoadRef.current === request) {
          pendingLoadRef.current = null;
          if (isMountedRef.current) setModelsLoading(false);
        }
      }
    },
    [baseUrl, lockedBaseUrl, provider, modelNeeds, testedModels, t]
  );

  useEffect(() => {
    if (!hasBase) {
      setModelsError(null);
      setModelOptions([]);
      setModelsLoading(false);
      lastLoadedBaseRef.current = null;
      return;
    }
    if (!normalizedBase) return;
    if (pendingLoadRef.current?.base === normalizedBase) return;
    if (lastLoadedBaseRef.current === normalizedBase) return;
    loadRemoteModels();
  }, [hasBase, normalizedBase, loadRemoteModels]);

  // Different credentials can see different models at the same address. Wait for
  // the current check to settle and for any older catalog load to finish.
  useEffect(() => {
    // Clearing OpenRouter's saved key makes its public catalog available without a check.
    const publicCatalog =
      visible && provider === "openrouter" && !apiKey.trim() && !savedApiKey.trim();
    const settled =
      check.phase === "connected" || check.phase === "unverified" || check.phase === "failed";
    if (!settled && !publicCatalog) return;
    if (!hasBase) return;
    if (pendingLoadRef.current?.base === normalizedBase) return;
    if (
      apiKey.trim() === lastLoadedKeyRef.current &&
      check.credentialRevision === lastLoadedRevisionRef.current
    ) {
      return;
    }
    loadRemoteModels(undefined, true);
  }, [
    check.phase,
    check.credentialRevision,
    apiKey,
    savedApiKey,
    provider,
    visible,
    hasBase,
    normalizedBase,
    modelsLoading,
    loadRemoteModels,
  ]);

  const applyBase = useCallback(() => {
    const normalized = trimmedDraft ? normalizeBaseUrl(trimmedDraft) : trimmedDraft;
    setDraftBase(normalized);
    setBaseUrl(normalized);
    lastLoadedBaseRef.current = null;
    loadRemoteModels(normalized, true);
  }, [trimmedDraft, setBaseUrl, loadRemoteModels]);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLInputElement>) => {
      // Switching to another app blurs the field mid-edit; the address applies once it is left.
      if (isWindowSwitchBlur(event)) return;
      if (!trimmedDraft) return;
      if (trimmedDraft !== (baseUrl || "").trim()) {
        applyBase();
      }
    },
    [trimmedDraft, baseUrl, applyBase]
  );

  const handleReset = useCallback(() => {
    const target = defaultBaseUrl ?? "";
    setDraftBase(target);
    setBaseUrl(target);
    lastLoadedBaseRef.current = null;
    loadRemoteModels(target, true);
  }, [defaultBaseUrl, setBaseUrl, loadRemoteModels]);

  const handleRefresh = useCallback(() => {
    if (isDraftDirty) {
      applyBase();
      return;
    }
    if (!trimmedDraft) return;
    loadRemoteModels(undefined, true);
  }, [applyBase, isDraftDirty, trimmedDraft, loadRemoteModels]);

  // Preserve an incompatible saved pick only while it is selected, without reloading the catalog.
  const displayedModels = useMemo(
    (): ModelOption[] =>
      isDraftDirty
        ? []
        : modelOptions.filter(
            (option): boolean => option.eligibleForScope || option.value === model
          ),
    [isDraftDirty, modelOptions, model]
  );
  const queryUrl = buildApiUrl(hasBase ? normalizedBase : baseUrlPlaceholder, "/models");

  return (
    <>
      <ConnectionCheckAnnouncer announcement={check.announcement} />
      {!lockedBaseUrl && (
        <div className="space-y-2" onFocus={editing.onFocus} onBlur={editing.onBlur}>
          <h4 className="font-medium text-foreground">{t("reasoning.custom.endpointTitle")}</h4>
          <ProviderCheckField
            aria-label={t("reasoning.custom.endpointTitle")}
            check={endpointCheck}
            failureReason={failureReason}
            value={draftBase}
            onChange={(event) => setDraftBase(event.target.value)}
            onBlur={handleBlur}
            placeholder={baseUrlPlaceholder}
            autoComplete="off"
            spellCheck={false}
          />
          {helpExamples ?? (
            <p className="text-xs text-muted-foreground">
              {t("reasoning.custom.endpointExamples")}{" "}
              <code dir="ltr" className="text-primary">
                https://openrouter.ai/api/v1
              </code>{" "}
              (OpenRouter),{" "}
              <code dir="ltr" className="text-primary">
                https://api.together.xyz/v1
              </code>{" "}
              (Together).
            </p>
          )}
        </div>
      )}

      <div className="space-y-2 pt-3" onFocus={editing.onFocus} onBlur={editing.onBlur}>
        <div className="flex items-baseline justify-between">
          <h4 className="font-medium text-foreground">{keyLabel}</h4>
          {getKeyUrl && <GetApiKeyLink url={getKeyUrl} />}
        </div>
        <ProviderCheckField
          aria-label={keyLabel}
          // At a fixed address the key completes the connection, so it carries the status.
          check={lockedBaseUrl ? check : undefined}
          invalidOn="credentialsRejected"
          type="password"
          value={apiKey}
          onChange={(event) => keyDraft.change("apiKey", event.target.value.trim(), setApiKey)}
          onBlur={keyDraft.save}
          placeholder={t("apiKeyInput.placeholder")}
          autoComplete="off"
          spellCheck={false}
        />
        <SecretRefErrorText code={keyDraft.error("apiKey")} />
        {!apiKeyRequired && (
          <p className="text-xs text-muted-foreground/70 mt-1">
            {t("reasoning.custom.apiKeyHelp")}
          </p>
        )}
        {apiKeyRequired && !apiKey.trim() && (
          <p className="text-xs text-warning">{t("reasoning.custom.keyRequiredHint")}</p>
        )}
      </div>

      <div className="space-y-2 pt-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-foreground">{t("reasoning.availableModels")}</h4>
          <div className="flex gap-2">
            {defaultBaseUrl !== undefined && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleReset}
                className="text-xs"
              >
                {t("common.reset")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleRefresh}
              disabled={modelsLoading || (!trimmedDraft && !hasSavedBase)}
              className="text-xs"
            >
              {modelsLoading
                ? t("common.loading")
                : isDraftDirty
                  ? t("reasoning.custom.applyAndRefresh")
                  : t("common.refresh")}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("reasoning.custom.queryPrefix")}{" "}
          <code dir="ltr" className="break-all">
            {queryUrl}
          </code>{" "}
          {t("reasoning.custom.querySuffix")}
        </p>
        {isDraftDirty && (
          <p className="text-xs text-primary">{t("reasoning.custom.modelsReloadHint")}</p>
        )}
        {!hasBase && <p className="text-xs text-warning">{t("reasoning.custom.enterEndpoint")}</p>}
        {hasBase && (
          <>
            {modelsLoading && (
              <p className="text-xs text-primary">{t("reasoning.custom.fetchingModels")}</p>
            )}
            {listErrorShown && <p className="text-xs text-destructive">{modelsError}</p>}
            {!modelsLoading && !modelsError && modelOptions.length === 0 && (
              <p className="text-xs text-warning">{t("reasoning.custom.noModels")}</p>
            )}
            {!modelsLoading && displayedModels.length > 0 && !model && (
              <p className="text-xs text-warning">{t("reasoning.custom.selectModelHint")}</p>
            )}
          </>
        )}
        {displayedModels.length > MODEL_SEARCH_THRESHOLD ||
        (testedModels && displayedModels.length > 0) ? (
          <SearchableModelList
            models={displayedModels}
            selectedModel={model}
            onModelSelect={setModel}
            modelRanking={testedModels ?? undefined}
          />
        ) : (
          <ModelCardList
            models={displayedModels}
            selectedModel={model}
            onModelSelect={setModel}
            truncateDescription
          />
        )}
      </div>
    </>
  );
}
