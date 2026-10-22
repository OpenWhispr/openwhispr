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
import { GetApiKeyLink } from "./ui/GetApiKeyLink";
import { ConnectionCheckAnnouncer } from "./ui/ConnectionCheckAnnouncer";
import { ProviderCheckField } from "./ui/ProviderCheckField";
import { usePanelVisible } from "./ui/usePanelVisible";
import { isWindowSwitchBlur, useFocusHold } from "../hooks/useFocusHold";
import { useConnectionAutoCheck } from "../hooks/useConnectionAutoCheck";
import { useCredentialDraft } from "../hooks/useCredentialDraft";
import { useTypingPause } from "../hooks/useTypingPause";

interface ModelOption {
  value: string;
  label: string;
  description?: string;
  ownedBy?: string;
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
}: OpenAICompatiblePanelProps) {
  const { t } = useTranslation();
  const [draftBase, setDraftBase] = useState(baseUrl);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const lastLoadedBaseRef = useRef<string | null>(null);
  // The trimmed key the last list load was sent with.
  const lastLoadedKeyRef = useRef<string | null>(null);
  const pendingBaseRef = useRef<string | null>(null);
  const latestBaseRef = useRef<string>(normalizeBaseUrl(baseUrl));
  const keyDraft = useCredentialDraft();
  const apiKey = keyDraft.value("apiKey", savedApiKey);
  // The list reads the key and the address setter through refs, so neither a key change nor
  // a parent's new setter on each render reloads it.
  const apiKeyRef = useRef(apiKey);
  const setBaseUrlRef = useRef(setBaseUrl);
  useEffect(() => {
    apiKeyRef.current = apiKey;
    setBaseUrlRef.current = setBaseUrl;
  }, [apiKey, setBaseUrl]);

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
  const followKeyDraft = keyDraft.follow;
  const refused = check.failure?.errorCode === "credentialsRejected";
  useEffect(() => {
    followKeyDraft({
      phase: check.phase,
      checked: { apiKey },
      // Someone's own server may refuse a key for other reasons, so only OpenRouter's refusal
      // holds a key back.
      refused: refused && provider === "openrouter",
    });
  }, [check.phase, apiKey, refused, provider, followKeyDraft]);

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
    !apiKey.trim() && refused ? t("reasoning.custom.endpointUnauthorized") : undefined;
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
      if (!force && pendingBaseRef.current === normalized) return;

      if (baseOverride !== undefined) {
        latestBaseRef.current = normalized;
      }

      pendingBaseRef.current = normalized;

      // Keep the previous list visible while refreshing so the searchable list
      // (and its query state) isn't unmounted mid-fetch.
      if (isMountedRef.current) {
        setModelsLoading(true);
        setModelsError(null);
      }

      const trimmedKey = apiKeyRef.current.trim();
      const effectiveKey = trimmedKey.length > 0 ? trimmedKey : undefined;
      lastLoadedKeyRef.current = effectiveKey ?? "";
      let activeBase = normalized;

      try {
        if (!normalized.includes("://")) {
          if (isMountedRef.current && latestBaseRef.current === normalized) {
            setModelsError(t("reasoning.custom.endpointWithProtocol"));
            setModelsLoading(false);
          }
          return;
        }

        if (!isSecureHttpEndpoint(normalized)) {
          if (isMountedRef.current && latestBaseRef.current === normalized) {
            setModelsError(t("reasoning.custom.httpsRequired"));
            setModelsLoading(false);
          }
          return;
        }

        const headers: Record<string, string> = {};
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

          // Coerce fields defensively: non-conformant endpoints may return
          // numeric ids or object descriptions, which would crash the render.
          return (rawModels as Array<Record<string, unknown>>)
            .map((item) => {
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
              return { value, label: value, description, ownedBy } as ModelOption;
            })
            .filter(Boolean) as ModelOption[];
        };

        // When the entered base yields no models, fall back through sibling
        // bases and adopt the working one so inference targets it too.
        const candidates = lockedBaseUrl ? [normalized] : getModelListBaseCandidates(normalized);
        let mapped: ModelOption[] = [];
        let resolvedBase = normalized;
        let primaryError: Error | null = null;

        for (const candidate of candidates) {
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

        if (isMountedRef.current && latestBaseRef.current === normalized) {
          if (resolvedBase !== normalized) {
            activeBase = resolvedBase;
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
        if (isMountedRef.current && latestBaseRef.current === normalized) {
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
        if (pendingBaseRef.current === normalized) {
          pendingBaseRef.current = null;
        }
        if (isMountedRef.current && latestBaseRef.current === activeBase) {
          setModelsLoading(false);
        }
      }
    },
    [baseUrl, lockedBaseUrl, t]
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
    if (pendingBaseRef.current === normalizedBase) return;
    if (lastLoadedBaseRef.current === normalizedBase) return;
    loadRemoteModels();
  }, [hasBase, normalizedBase, loadRemoteModels]);

  // A key change retries a failed list load once the check for that key has settled, so the
  // list never gets a half-typed key, and a hidden panel asks nothing: its check is not ready,
  // so it never settles. It also runs when a load that was in flight settles (`modelsLoading`
  // drops), since a key typed during that load has a check that settled before the load did.
  useEffect(() => {
    if (check.phase !== "connected" && check.phase !== "unverified" && check.phase !== "failed") {
      return;
    }
    if (!hasBase) return;
    if (lastLoadedBaseRef.current === normalizedBase) return;
    if (pendingBaseRef.current === normalizedBase) return;
    if (apiKey.trim() === lastLoadedKeyRef.current) return;
    loadRemoteModels();
  }, [check.phase, apiKey, hasBase, normalizedBase, modelsLoading, loadRemoteModels]);

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

  const displayedModels = isDraftDirty ? [] : modelOptions;
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
        {displayedModels.length > MODEL_SEARCH_THRESHOLD ? (
          <SearchableModelList
            models={displayedModels}
            selectedModel={model}
            onModelSelect={setModel}
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
