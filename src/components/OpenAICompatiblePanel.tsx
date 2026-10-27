import { useCallback, useEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
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
  const [draft, setDraft] = useState<string | null>(null);
  const draftBase = draft ?? baseUrl;
  const [catalog, setCatalog] = useState<{
    owner: string;
    options: ModelOption[];
    loading: boolean;
    error: { key: string } | { message: string } | null;
  }>({ owner: "", options: [], loading: false, error: null });
  const [searchable, setSearchable] = useState(false);
  const requestRef = useRef(0);
  const activeRequestRef = useRef<{ owner: string; controller: AbortController } | null>(null);
  const liveRef = useRef(false);
  const keyDraft = useCredentialDraft();
  const apiKey = keyDraft.value("apiKey", savedApiKey);
  useEffect(() => {
    liveRef.current = true;
    const requests = requestRef;
    return () => {
      liveRef.current = false;
      activeRequestRef.current?.controller.abort();
      activeRequestRef.current = null;
      requests.current++;
    };
  }, []);
  const completedOwnerRef = useRef<string | null>(null);
  const setBaseUrlRef = useRef(setBaseUrl);
  useEffect(() => {
    setBaseUrlRef.current = setBaseUrl;
  }, [setBaseUrl]);
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const effectiveKey = savedApiKey.trim();
  // Memory-only ownership; never persisted, logged or used as an allowlist.
  const owner = JSON.stringify([normalizedBase, effectiveKey, lockedBaseUrl]);
  const modelOptions = catalog.owner === owner ? catalog.options : [];
  const modelsLoading = catalog.owner === owner && catalog.loading;
  const modelsError =
    catalog.owner === owner && catalog.error
      ? "key" in catalog.error
        ? t(catalog.error.key)
        : catalog.error.message
      : null;

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
    async (baseOverride = normalizedBase) => {
      if (!liveRef.current) return;
      const normalized = normalizeBaseUrl(baseOverride);
      const owner = JSON.stringify([normalized, effectiveKey, lockedBaseUrl]);
      activeRequestRef.current?.controller.abort();
      completedOwnerRef.current = null;
      const request = ++requestRef.current;
      const isCurrent = () => liveRef.current && request === requestRef.current;
      const controller = new AbortController();
      activeRequestRef.current = { owner, controller };
      setCatalog((previous) => ({
        owner,
        options: previous.owner === owner ? previous.options : [],
        loading: !!normalized,
        error: null,
      }));
      if (!normalized) return;
      const invalidKey = !normalized.includes("://")
        ? "reasoning.custom.endpointWithProtocol"
        : !isSecureHttpEndpoint(normalized)
          ? "reasoning.custom.httpsRequired"
          : null;
      if (invalidKey) {
        setCatalog({ owner, options: [], loading: false, error: { key: invalidKey } });
        return;
      }
      try {
        const headers: Record<string, string> = {};
        if (effectiveKey) {
          headers.Authorization = `Bearer ${effectiveKey}`;
        }

        const fetchModelOptions = async (base: string): Promise<ModelOption[]> => {
          const response = await fetch(buildApiUrl(base, "/models"), {
            method: "GET",
            headers,
            signal: controller.signal,
          });

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
                typeof item?.description === "string" ? item.description : undefined;
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

        if (!isCurrent()) return;
        const resolvedOwner = JSON.stringify([resolvedBase, effectiveKey, lockedBaseUrl]);
        completedOwnerRef.current = resolvedOwner;
        setCatalog({ owner: resolvedOwner, options: mapped, loading: false, error: null });
        if (mapped.length > MODEL_SEARCH_THRESHOLD) setSearchable(true);
        // Discovery never clears a manually entered model ID or endpoint draft.
        if (resolvedBase !== normalized) {
          activeRequestRef.current = { owner: resolvedOwner, controller };
          setBaseUrlRef.current(resolvedBase);
        }
      } catch (error) {
        if (!isCurrent()) return;
        const message = error instanceof Error ? error.message : "";
        setCatalog({
          owner,
          options: [],
          loading: false,
          error:
            /\b(401|403)\b/.test(message) && !effectiveKey
              ? { key: "reasoning.custom.endpointUnauthorized" }
              : message
                ? { message }
                : { key: "reasoning.custom.unableToLoadModels" },
        });
      }
    },
    [normalizedBase, effectiveKey, lockedBaseUrl]
  );

  // Automatic discovery synchronizes the committed configuration with a
  // remote catalog. Explicit Apply/Reset/Refresh requests stay in their events.
  useEffect(() => {
    if (!visible || isDraftDirty || apiKey.trim() !== effectiveKey) return;
    if (completedOwnerRef.current !== owner && activeRequestRef.current?.owner !== owner)
      void loadRemoteModels();
    const requests = requestRef;
    return () => {
      const active = activeRequestRef.current;
      if (active?.owner === owner) {
        active.controller.abort();
        activeRequestRef.current = null;
        requests.current++;
      }
    };
  }, [owner, loadRemoteModels, visible, isDraftDirty, apiKey, effectiveKey]);

  const applyBase = () => {
    const normalized = trimmedDraft ? normalizeBaseUrl(trimmedDraft) : trimmedDraft;
    setDraft(null);
    setBaseUrl(normalized);
    void loadRemoteModels(normalized);
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    if (isWindowSwitchBlur(event)) return;
    if (trimmedDraft && isDraftDirty) applyBase();
  };

  const handleReset = () => {
    const target = defaultBaseUrl ?? "";
    setDraft(null);
    setBaseUrl(target);
    void loadRemoteModels(target);
  };

  const handleRefresh = () => {
    if (isDraftDirty) {
      applyBase();
      return;
    }
    if (!trimmedDraft) return;
    void loadRemoteModels();
  };

  const displayedModels = isDraftDirty
    ? []
    : modelOptions.map((option) => ({
        ...option,
        description:
          option.description ||
          (option.ownedBy
            ? t("reasoning.custom.ownerLabel", { owner: option.ownedBy })
            : undefined),
      }));
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
            onChange={(event) =>
              setDraft(event.target.value.trim() === baseUrl.trim() ? null : event.target.value)
            }
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
        {searchable ? (
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
