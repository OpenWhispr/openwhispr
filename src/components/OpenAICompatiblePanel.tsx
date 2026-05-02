import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import ApiKeyInput from "./ui/ApiKeyInput";
import ModelCardList from "./ui/ModelCardList";
import { buildApiUrl, normalizeBaseUrl } from "../config/constants";
import { isSecureEndpoint } from "../utils/urlUtils";

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
}: OpenAICompatiblePanelProps) {
  const { t } = useTranslation();
  const [draftBase, setDraftBase] = useState(baseUrl);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const isMountedRef = useRef(true);
  const lastLoadedBaseRef = useRef<string | null>(null);
  const pendingBaseRef = useRef<string | null>(null);
  const latestBaseRef = useRef<string>(normalizeBaseUrl(baseUrl));

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

  useEffect(() => {
    latestBaseRef.current = normalizedBase;
  }, [normalizedBase]);

  const hasBase = normalizedBase !== "";
  const trimmedDraft = draftBase.trim();
  const hasSavedBase = Boolean((baseUrl || "").trim());
  const isDraftDirty = trimmedDraft !== (baseUrl || "").trim();

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

      if (isMountedRef.current) {
        setModelsLoading(true);
        setModelsError(null);
        setModelOptions([]);
      }

      const trimmedKey = apiKey?.trim();
      const effectiveKey = trimmedKey && trimmedKey.length > 0 ? trimmedKey : undefined;

      try {
        if (!normalized.includes("://")) {
          if (isMountedRef.current && latestBaseRef.current === normalized) {
            setModelsError(t("reasoning.custom.endpointWithProtocol"));
            setModelsLoading(false);
          }
          return;
        }

        if (!isSecureEndpoint(normalized)) {
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

        const modelsUrl = buildApiUrl(normalized, "/models");
        const response = await fetch(modelsUrl, { method: "GET", headers });

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

        const mapped = (rawModels as Array<Record<string, unknown>>)
          .map((item) => {
            const value = (item?.id || item?.name) as string | undefined;
            if (!value) return null;
            const ownedBy = typeof item?.owned_by === "string" ? item.owned_by : undefined;
            return {
              value,
              label: (item?.id || item?.name || value) as string,
              description:
                (item?.description as string) ||
                (ownedBy ? t("reasoning.custom.ownerLabel", { owner: ownedBy }) : undefined),
              ownedBy,
            } as ModelOption;
          })
          .filter(Boolean) as ModelOption[];

        if (isMountedRef.current && latestBaseRef.current === normalized) {
          setModelOptions(mapped);
          if (model && mapped.length > 0 && !mapped.some((m) => m.value === model)) {
            setModel("");
          }
          setModelsError(null);
          lastLoadedBaseRef.current = normalized;
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
        if (isMountedRef.current && latestBaseRef.current === normalized) {
          setModelsLoading(false);
        }
      }
    },
    [baseUrl, apiKey, model, setModel, t]
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

  const applyBase = useCallback(() => {
    const normalized = trimmedDraft ? normalizeBaseUrl(trimmedDraft) : trimmedDraft;
    setDraftBase(normalized);
    setBaseUrl(normalized);
    lastLoadedBaseRef.current = null;
    loadRemoteModels(normalized, true);
  }, [trimmedDraft, setBaseUrl, loadRemoteModels]);

  const handleBlur = useCallback(() => {
    if (!trimmedDraft) return;
    if (trimmedDraft !== (baseUrl || "").trim()) {
      applyBase();
    }
  }, [trimmedDraft, baseUrl, applyBase]);

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
  const queryUrl = hasBase ? `${normalizedBase}/models` : `${baseUrlPlaceholder}/models`;

  return (
    <>
      <div className="space-y-2">
        <h4 className="font-medium text-foreground">{t("reasoning.custom.endpointTitle")}</h4>
        <Input
          value={draftBase}
          onChange={(event) => setDraftBase(event.target.value)}
          onBlur={handleBlur}
          placeholder={baseUrlPlaceholder}
          className="text-sm"
        />
        {helpExamples ?? (
          <p className="text-xs text-muted-foreground">
            {t("reasoning.custom.endpointExamples")}{" "}
            <code className="text-primary">http://localhost:11434/v1</code>{" "}
            {t("reasoning.custom.ollama")},{" "}
            <code className="text-primary">http://localhost:8080/v1</code>{" "}
            {t("reasoning.custom.localAi")}.
          </p>
        )}
      </div>

      <div className="space-y-2 pt-3">
        <h4 className="font-medium text-foreground">{t("reasoning.custom.apiKeyOptional")}</h4>
        <ApiKeyInput
          apiKey={apiKey}
          setApiKey={setApiKey}
          label=""
          helpText={t("reasoning.custom.apiKeyHelp")}
        />
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
          {t("reasoning.custom.queryPrefix")} <code className="break-all">{queryUrl}</code>{" "}
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
          </>
        )}
        <ModelCardList models={displayedModels} selectedModel={model} onModelSelect={setModel} />
      </div>
    </>
  );
}
