import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import ApiKeyInput from "./ui/ApiKeyInput";
import ModelCardList from "./ui/ModelCardList";
import SearchableModelList, { MODEL_SEARCH_THRESHOLD } from "./ui/SearchableModelList";
import { buildApiUrl, getModelListBaseCandidates, normalizeBaseUrl } from "../config/constants";
import { isSecureHttpEndpoint } from "../utils/urlUtils";
import { GetApiKeyLink } from "./ui/GetApiKeyLink";

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
}

export default function OpenAICompatiblePanel({
  baseUrl,
  setBaseUrl,
  apiKey,
  setApiKey,
  model,
  setModel,
  defaultBaseUrl,
  baseUrlPlaceholder = "https://api.openai.com/v1",
  helpExamples,
  lockedBaseUrl = false,
  apiKeyRequired = false,
  getKeyUrl,
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
  const adoptedOwnerRef = useRef<string | null>(null);
  const setBaseUrlRef = useRef(setBaseUrl);
  useEffect(() => {
    setBaseUrlRef.current = setBaseUrl;
  }, [setBaseUrl]);
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const effectiveKey = apiKey.trim();
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

  const hasBase = normalizedBase !== "";
  const trimmedDraft = draftBase.trim();
  const hasSavedBase = Boolean((baseUrl || "").trim());
  const isDraftDirty = trimmedDraft !== (baseUrl || "").trim();

  const loadRemoteModels = useCallback(
    async (baseOverride = normalizedBase) => {
      if (!liveRef.current) return;
      const normalized = normalizeBaseUrl(baseOverride);
      const owner = JSON.stringify([normalized, effectiveKey, lockedBaseUrl]);
      activeRequestRef.current?.controller.abort();
      adoptedOwnerRef.current = null;
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
        setCatalog({ owner: resolvedOwner, options: mapped, loading: false, error: null });
        if (mapped.length > MODEL_SEARCH_THRESHOLD) setSearchable(true);
        // Discovery never clears a manually entered model ID or endpoint draft.
        if (resolvedBase !== normalized) {
          adoptedOwnerRef.current = resolvedOwner;
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
    if (adoptedOwnerRef.current === owner) adoptedOwnerRef.current = null;
    else if (activeRequestRef.current?.owner !== owner) void loadRemoteModels();
    const requests = requestRef;
    return () => {
      const active = activeRequestRef.current;
      if (active?.owner === owner) {
        active.controller.abort();
        activeRequestRef.current = null;
        requests.current++;
      }
    };
  }, [owner, loadRemoteModels]);

  const applyBase = () => {
    const normalized = trimmedDraft ? normalizeBaseUrl(trimmedDraft) : trimmedDraft;
    setDraft(null);
    setBaseUrl(normalized);
    void loadRemoteModels(normalized);
  };

  const handleBlur = () => {
    if (!trimmedDraft) return;
    if (trimmedDraft !== (baseUrl || "").trim()) {
      applyBase();
    }
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
      {!lockedBaseUrl && (
        <div className="space-y-2">
          <h4 className="font-medium text-foreground">{t("reasoning.custom.endpointTitle")}</h4>
          <Input
            aria-label={t("reasoning.custom.endpointTitle")}
            dir="ltr"
            value={draftBase}
            onChange={(event) =>
              setDraft(event.target.value.trim() === baseUrl.trim() ? null : event.target.value)
            }
            onBlur={handleBlur}
            placeholder={baseUrlPlaceholder}
            className="text-sm"
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

      <div className="space-y-2 pt-3">
        <div className="flex items-baseline justify-between">
          <h4 className="font-medium text-foreground">
            {t(apiKeyRequired ? "common.apiKey" : "reasoning.custom.apiKeyOptional")}
          </h4>
          {getKeyUrl && <GetApiKeyLink url={getKeyUrl} />}
        </div>
        <ApiKeyInput
          apiKey={apiKey}
          setApiKey={setApiKey}
          label=""
          helpText={apiKeyRequired ? "" : t("reasoning.custom.apiKeyHelp")}
        />
        {apiKeyRequired && !apiKey?.trim() && (
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
            {modelsError && <p className="text-xs text-destructive">{modelsError}</p>}
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
