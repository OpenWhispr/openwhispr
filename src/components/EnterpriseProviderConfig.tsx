import { useCallback, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Search } from "./icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import ApiKeyInput from "./ui/ApiKeyInput";
import ModelCardList, { type ModelCardOption } from "./ui/ModelCardList";
import SearchableModelList from "./ui/SearchableModelList";
import CustomModelInput from "./ui/CustomModelInput";
import TestConnectionButton from "./TestConnectionButton";
import { REASONING_PROVIDERS } from "../models/ModelRegistry";
import { useSettingsStore } from "../stores/settingsStore";
import { usePolicyStore } from "../stores/policyStore";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";
import { adjustBedrockModelForRegion, BEDROCK_REGIONS } from "../utils/bedrockRegions";

interface EnterpriseProviderConfigProps {
  provider: "bedrock" | "azure" | "vertex";
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
}

const VERTEX_LOCATIONS = [
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-west1",
  "us-west4",
  "us-south1",
  "northamerica-northeast1",
  "northamerica-northeast2",
  "southamerica-east1",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "europe-west6",
  "europe-west8",
  "europe-west9",
  "europe-north1",
  "europe-central2",
  "europe-southwest1",
  "asia-east1",
  "asia-east2",
  "asia-northeast1",
  "asia-northeast2",
  "asia-northeast3",
  "asia-south1",
  "asia-southeast1",
  "asia-southeast2",
  "australia-southeast1",
  "australia-southeast2",
  "me-west1",
];

function AuthModeToggle({
  options,
  value,
  onChange,
}: {
  options: { id: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("reasoning.enterprise.authMode")}
      className="flex gap-1 p-0.5 bg-muted rounded-md w-fit"
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          aria-pressed={value === opt.id}
          onClick={() => onChange(opt.id)}
          className={`px-2.5 py-1 text-xs rounded-sm transition-colors ${
            value === opt.id
              ? "bg-background text-foreground shadow-sm font-medium"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function FieldLabel({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
      {children}
    </label>
  );
}

function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground/70">{children}</p>;
}

function useSuggestedModels(provider: "bedrock" | "vertex") {
  const { t } = useTranslation();
  return useMemo(() => {
    const providerData = REASONING_PROVIDERS[provider];
    if (!providerData?.models?.length) return [];
    const iconUrl = getProviderIcon(provider);
    const invertInDark = isMonochromeProvider(provider);
    return providerData.models.map((m) => ({
      ...m,
      description: m.descriptionKey
        ? t(m.descriptionKey, { defaultValue: m.description })
        : m.description,
      icon: iconUrl,
      invertInDark,
    }));
  }, [t, provider]);
}

const EMPTY_CATALOG: ModelCardOption[] = [];

type BedrockCatalogState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; models: ModelCardOption[] };

function BedrockConfig({ reasoningModel, setReasoningModel }: EnterpriseProviderConfigProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const store = useSettingsStore(
    useShallow((s) => ({
      bedrockAuthMode: s.bedrockAuthMode,
      setBedrockAuthMode: s.setBedrockAuthMode,
      bedrockRegion: s.bedrockRegion,
      setBedrockRegion: s.setBedrockRegion,
      bedrockProfile: s.bedrockProfile,
      setBedrockProfile: s.setBedrockProfile,
      bedrockAccessKeyId: s.bedrockAccessKeyId,
      setBedrockAccessKeyId: s.setBedrockAccessKeyId,
      bedrockSecretAccessKey: s.bedrockSecretAccessKey,
      setBedrockSecretAccessKey: s.setBedrockSecretAccessKey,
      bedrockSessionToken: s.bedrockSessionToken,
      setBedrockSessionToken: s.setBedrockSessionToken,
    }))
  );
  const suggestedModels = useSuggestedModels("bedrock");
  const [catalogState, setCatalogState] = useState<{
    lease: object | null;
    data: BedrockCatalogState;
  }>({
    lease: null,
    data: { status: "idle" },
  });
  const [catalogVisited, setCatalogVisited] = useState(false);
  const catalogRequestRef = useRef(0);
  const accountId = usePolicyStore((s) => s.accountId);
  const authGeneration = usePolicyStore((s) => s.authGeneration);

  const regionModels = useMemo(
    () =>
      suggestedModels.map((m) => ({
        ...m,
        value: adjustBedrockModelForRegion(m.value, store.bedrockRegion),
      })),
    [suggestedModels, store.bedrockRegion]
  );

  const getConnectionConfig = () => ({
    bedrockRegion: store.bedrockRegion,
    bedrockProfile: store.bedrockAuthMode === "sso" ? store.bedrockProfile : "",
    bedrockAccessKeyId: store.bedrockAuthMode === "keys" ? store.bedrockAccessKeyId : "",
    bedrockSecretAccessKey: store.bedrockAuthMode === "keys" ? store.bedrockSecretAccessKey : "",
    bedrockSessionToken: store.bedrockAuthMode === "keys" ? store.bedrockSessionToken : "",
  });

  const catalogOwner = JSON.stringify([
    accountId,
    authGeneration,
    store.bedrockAuthMode,
    getConnectionConfig(),
  ]);
  const [configuration, setConfiguration] = useState({ key: catalogOwner });
  if (configuration.key !== catalogOwner) setConfiguration({ key: catalogOwner });
  const catalog: BedrockCatalogState =
    catalogState.lease === configuration ? catalogState.data : { status: "idle" };
  const catalogLeaseRef = useRef<object | null>(null);
  const bindCatalog = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      catalogLeaseRef.current = configuration;
      return () => {
        if (catalogLeaseRef.current === configuration) catalogLeaseRef.current = null;
      };
    },
    [configuration]
  );

  const loadCatalog = async () => {
    const requestId = ++catalogRequestRef.current;
    const isCurrent = () =>
      catalogLeaseRef.current === configuration && requestId === catalogRequestRef.current;
    const publish = (data: BedrockCatalogState) => {
      if (isCurrent()) setCatalogState({ lease: configuration, data });
    };
    publish({ status: "loading" });
    try {
      const result = await window.electronAPI?.listBedrockModels?.(getConnectionConfig());
      if (!isCurrent()) return;
      if (result?.success && Array.isArray(result.models)) {
        publish({
          status: "loaded",
          models: result.models.map((m) => ({ value: m.value, label: m.label, group: m.vendor })),
        });
        setCatalogVisited(true);
      } else {
        publish({
          status: "error",
          error: result?.error || t("reasoning.enterprise.modelListError"),
        });
      }
    } catch {
      publish({ status: "error", error: t("reasoning.enterprise.modelListError") });
    }
  };

  const handleRegionChange = (region: string) => {
    store.setBedrockRegion(region);
    const adjusted = adjustBedrockModelForRegion(reasoningModel, region);
    if (adjusted !== reasoningModel) setReasoningModel(adjusted);
  };

  const getTestConfig = () => ({
    ...getConnectionConfig(),
    model: reasoningModel,
  });

  return (
    <div ref={bindCatalog} className="space-y-3">
      <div className="space-y-1.5">
        <FieldLabel>
          {t("reasoning.enterprise.authMode", { defaultValue: "Authentication" })}
        </FieldLabel>
        <AuthModeToggle
          options={[
            {
              id: "sso",
              label: t("reasoning.enterprise.ssoProfile", { defaultValue: "SSO Profile" }),
            },
            {
              id: "keys",
              label: t("reasoning.enterprise.accessKeys", { defaultValue: "Access Keys" }),
            },
          ]}
          value={store.bedrockAuthMode}
          onChange={store.setBedrockAuthMode}
        />
      </div>

      {store.bedrockAuthMode === "sso" ? (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${fieldId}-profile`}>
              {t("reasoning.enterprise.profile", { defaultValue: "Profile Name" })}
            </FieldLabel>
            <Input
              dir="ltr"
              id={`${fieldId}-profile`}
              value={store.bedrockProfile}
              onChange={(e) => store.setBedrockProfile(e.target.value)}
              placeholder="default"
              className="text-sm"
            />
            <FieldHint>
              {t("reasoning.enterprise.bedrock.ssoHelp", {
                defaultValue:
                  "Uses your AWS CLI SSO configuration. Ensure you have run 'aws sso login'.",
              })}
            </FieldHint>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${fieldId}-access-key`}>
              {t("reasoning.enterprise.accessKeyId", { defaultValue: "Access Key ID" })}
            </FieldLabel>
            <ApiKeyInput
              id={`${fieldId}-access-key`}
              ariaLabel={t("reasoning.enterprise.accessKeyId")}
              apiKey={store.bedrockAccessKeyId}
              setApiKey={store.setBedrockAccessKeyId}
              label=""
              placeholder="AKIA..."
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${fieldId}-secret-key`}>
              {t("reasoning.enterprise.secretAccessKey", { defaultValue: "Secret Access Key" })}
            </FieldLabel>
            <ApiKeyInput
              id={`${fieldId}-secret-key`}
              ariaLabel={t("reasoning.enterprise.secretAccessKey")}
              apiKey={store.bedrockSecretAccessKey}
              setApiKey={store.setBedrockSecretAccessKey}
              label=""
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel htmlFor={`${fieldId}-session-token`}>
              {t("reasoning.enterprise.sessionToken", {
                defaultValue: "Session Token (optional)",
              })}
            </FieldLabel>
            <ApiKeyInput
              id={`${fieldId}-session-token`}
              ariaLabel={t("reasoning.enterprise.sessionToken")}
              apiKey={store.bedrockSessionToken}
              setApiKey={store.setBedrockSessionToken}
              label=""
            />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <FieldLabel htmlFor={`${fieldId}-region`}>
          {t("reasoning.enterprise.region", { defaultValue: "Region" })}
        </FieldLabel>
        <select
          dir="ltr"
          id={`${fieldId}-region`}
          value={store.bedrockRegion}
          onChange={(e) => handleRegionChange(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {BEDROCK_REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      {regionModels.length > 0 && (
        <div className="space-y-1.5">
          <FieldLabel>
            {t("reasoning.enterprise.suggestedModels", { defaultValue: "Suggested Models" })}
          </FieldLabel>
          <ModelCardList
            models={regionModels}
            selectedModel={reasoningModel}
            onModelSelect={setReasoningModel}
            colorScheme="purple"
          />
        </div>
      )}

      {catalogVisited && (
        <div hidden={catalog.status !== "loaded"} className="space-y-1.5">
          <FieldLabel>
            {t("reasoning.enterprise.allModels", {
              defaultValue: "All Models in {{region}}",
              region: store.bedrockRegion,
            })}
          </FieldLabel>
          <SearchableModelList
            models={catalog.status === "loaded" ? catalog.models : EMPTY_CATALOG}
            selectedModel={reasoningModel}
            onModelSelect={setReasoningModel}
          />
        </div>
      )}
      {catalog.status !== "loaded" && (
        <div className="space-y-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            aria-busy={catalog.status === "loading"}
            onClick={() => {
              if (catalog.status !== "loading") void loadCatalog();
            }}
          >
            {catalog.status === "loading" ? (
              <Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" />
            ) : (
              <Search className="w-3.5 h-3.5 me-1.5" />
            )}
            {catalog.status === "loading"
              ? t("reasoning.enterprise.loadingModels", { defaultValue: "Fetching models..." })
              : catalog.status === "error"
                ? t("common.retry", { defaultValue: "Retry" })
                : t("reasoning.enterprise.browseModels", { defaultValue: "Browse all models" })}
          </Button>
          {catalog.status === "error" && (
            <FieldHint>
              <span role="alert" className="text-destructive">
                {catalog.error}
              </span>
            </FieldHint>
          )}
        </div>
      )}

      <CustomModelInput value={reasoningModel} onChange={setReasoningModel} />

      <TestConnectionButton
        provider="bedrock"
        getConfig={getTestConfig}
        configurationKey={JSON.stringify([store.bedrockAuthMode, getTestConfig()])}
      />
    </div>
  );
}

function AzureConfig({ reasoningModel, setReasoningModel }: EnterpriseProviderConfigProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const store = useSettingsStore(
    useShallow((s) => ({
      azureEndpoint: s.azureEndpoint,
      setAzureEndpoint: s.setAzureEndpoint,
      azureApiKey: s.azureApiKey,
      setAzureApiKey: s.setAzureApiKey,
      azureDeploymentName: s.azureDeploymentName,
      setAzureDeploymentName: s.setAzureDeploymentName,
      azureApiVersion: s.azureApiVersion,
      setAzureApiVersion: s.setAzureApiVersion,
    }))
  );

  const getTestConfig = () => ({
    azureEndpoint: store.azureEndpoint,
    azureApiVersion: store.azureApiVersion,
    apiKey: store.azureApiKey,
    model: store.azureDeploymentName || reasoningModel,
  });

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <FieldLabel htmlFor={`${fieldId}-endpoint`}>
          {t("reasoning.enterprise.endpoint", { defaultValue: "Endpoint URL" })}
        </FieldLabel>
        <Input
          dir="ltr"
          id={`${fieldId}-endpoint`}
          value={store.azureEndpoint}
          onChange={(e) => store.setAzureEndpoint(e.target.value)}
          placeholder="https://yourresource.openai.azure.com"
          className="text-sm"
        />
        <FieldHint>
          {t("reasoning.enterprise.azure.endpointHelp", {
            defaultValue:
              "Your Azure OpenAI resource endpoint (e.g., https://myresource.openai.azure.com).",
          })}
        </FieldHint>
      </div>

      <div className="space-y-1.5">
        <FieldLabel htmlFor={`${fieldId}-api-key`}>{t("common.apiKey")}</FieldLabel>
        <ApiKeyInput
          id={`${fieldId}-api-key`}
          apiKey={store.azureApiKey}
          setApiKey={store.setAzureApiKey}
          label=""
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel htmlFor={`${fieldId}-deployment`}>
          {t("reasoning.enterprise.deploymentName", { defaultValue: "Deployment Name" })}
        </FieldLabel>
        <Input
          dir="ltr"
          id={`${fieldId}-deployment`}
          value={store.azureDeploymentName}
          onChange={(e) => {
            store.setAzureDeploymentName(e.target.value);
            setReasoningModel(e.target.value);
          }}
          placeholder="gpt-4o-deployment"
          className="text-sm font-mono"
        />
        <FieldHint>
          {t("reasoning.enterprise.azure.deploymentHelp", {
            defaultValue: "The name of your model deployment in Azure OpenAI.",
          })}
        </FieldHint>
      </div>

      <div className="space-y-1.5">
        <FieldLabel htmlFor={`${fieldId}-version`}>
          {t("reasoning.enterprise.apiVersion", { defaultValue: "API Version" })}
        </FieldLabel>
        <Input
          dir="ltr"
          id={`${fieldId}-version`}
          value={store.azureApiVersion}
          onChange={(e) => store.setAzureApiVersion(e.target.value)}
          placeholder="2024-10-21"
          className="text-sm font-mono"
        />
      </div>

      <TestConnectionButton
        provider="azure"
        getConfig={getTestConfig}
        configurationKey={JSON.stringify(getTestConfig())}
      />
    </div>
  );
}

function VertexConfig({ reasoningModel, setReasoningModel }: EnterpriseProviderConfigProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const store = useSettingsStore(
    useShallow((s) => ({
      vertexAuthMode: s.vertexAuthMode,
      setVertexAuthMode: s.setVertexAuthMode,
      vertexProject: s.vertexProject,
      setVertexProject: s.setVertexProject,
      vertexLocation: s.vertexLocation,
      setVertexLocation: s.setVertexLocation,
      vertexApiKey: s.vertexApiKey,
      setVertexApiKey: s.setVertexApiKey,
    }))
  );
  const suggestedModels = useSuggestedModels("vertex");

  const getTestConfig = () => ({
    vertexProject: store.vertexProject,
    vertexLocation: store.vertexLocation,
    apiKey: store.vertexAuthMode === "apikey" ? store.vertexApiKey : "",
    model: reasoningModel,
  });

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <FieldLabel>
          {t("reasoning.enterprise.authMode", { defaultValue: "Authentication" })}
        </FieldLabel>
        <AuthModeToggle
          options={[
            {
              id: "adc",
              label: t("reasoning.enterprise.adc", {
                defaultValue: "Application Default Credentials",
              }),
            },
            {
              id: "apikey",
              label: t("reasoning.enterprise.apiKeyMode", { defaultValue: "API Key" }),
            },
          ]}
          value={store.vertexAuthMode}
          onChange={store.setVertexAuthMode}
        />
      </div>

      {store.vertexAuthMode === "apikey" ? (
        <div className="space-y-1.5">
          <FieldLabel htmlFor={`${fieldId}-api-key`}>{t("common.apiKey")}</FieldLabel>
          <ApiKeyInput
            id={`${fieldId}-api-key`}
            apiKey={store.vertexApiKey}
            setApiKey={store.setVertexApiKey}
            label=""
            helpText={t("reasoning.enterprise.vertex.apikeyHelp", {
              defaultValue: "Vertex AI Express Mode API key from Google AI Studio.",
            })}
          />
        </div>
      ) : (
        <FieldHint>
          {t("reasoning.enterprise.vertex.adcHelp", {
            defaultValue:
              "Uses Application Default Credentials. Run: gcloud auth application-default login",
          })}
        </FieldHint>
      )}

      <div className="space-y-1.5">
        <FieldLabel htmlFor={`${fieldId}-project`}>
          {t("reasoning.enterprise.projectId", { defaultValue: "Project ID" })}
        </FieldLabel>
        <Input
          dir="ltr"
          id={`${fieldId}-project`}
          value={store.vertexProject}
          onChange={(e) => store.setVertexProject(e.target.value)}
          placeholder="my-gcp-project-123"
          className="text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel htmlFor={`${fieldId}-location`}>
          {t("reasoning.enterprise.location", { defaultValue: "Location" })}
        </FieldLabel>
        <select
          dir="ltr"
          id={`${fieldId}-location`}
          value={store.vertexLocation}
          onChange={(e) => store.setVertexLocation(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {VERTEX_LOCATIONS.map((loc) => (
            <option key={loc} value={loc}>
              {loc}
            </option>
          ))}
        </select>
      </div>

      {suggestedModels.length > 0 && (
        <div className="space-y-1.5">
          <FieldLabel>
            {t("reasoning.enterprise.suggestedModels", { defaultValue: "Suggested Models" })}
          </FieldLabel>
          <ModelCardList
            models={suggestedModels}
            selectedModel={reasoningModel}
            onModelSelect={setReasoningModel}
            colorScheme="purple"
          />
        </div>
      )}

      <CustomModelInput value={reasoningModel} onChange={setReasoningModel} />

      <TestConnectionButton
        provider="vertex"
        getConfig={getTestConfig}
        configurationKey={JSON.stringify([store.vertexAuthMode, getTestConfig()])}
      />
    </div>
  );
}

export default function EnterpriseProviderConfig(props: EnterpriseProviderConfigProps) {
  switch (props.provider) {
    case "bedrock":
      return <BedrockConfig {...props} />;
    case "azure":
      return <AzureConfig {...props} />;
    case "vertex":
      return <VertexConfig {...props} />;
    default:
      return null;
  }
}
