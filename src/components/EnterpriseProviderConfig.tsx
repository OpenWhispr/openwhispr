import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "./ui/input";
import ApiKeyInput from "./ui/ApiKeyInput";
import ModelCardList from "./ui/ModelCardList";
import CustomModelInput from "./ui/CustomModelInput";
import TestConnectionButton from "./TestConnectionButton";
import { REASONING_PROVIDERS } from "../models/ModelRegistry";
import { useSettingsStore } from "../stores/settingsStore";
import { getProviderIcon, isMonochromeProvider } from "../utils/providerIcons";

interface EnterpriseProviderConfigProps {
  provider: "bedrock" | "azure" | "vertex";
  reasoningModel: string;
  setReasoningModel: (model: string) => void;
}

const BEDROCK_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "eu-central-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-north-1",
  "eu-south-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "sa-east-1",
  "me-central-1",
  "af-south-1",
];

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
  return (
    <div className="flex gap-1 p-0.5 bg-muted rounded-md w-fit">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
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

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-xs font-medium text-muted-foreground">{children}</label>;
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

function BedrockConfig({ reasoningModel, setReasoningModel }: EnterpriseProviderConfigProps) {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const suggestedModels = useSuggestedModels("bedrock");

  const getTestConfig = () => ({
    bedrockRegion: store.bedrockRegion,
    bedrockProfile: store.bedrockAuthMode === "sso" ? store.bedrockProfile : "",
    bedrockAccessKeyId: store.bedrockAuthMode === "keys" ? store.bedrockAccessKeyId : "",
    bedrockSecretAccessKey: store.bedrockAuthMode === "keys" ? store.bedrockSecretAccessKey : "",
    bedrockSessionToken: store.bedrockAuthMode === "keys" ? store.bedrockSessionToken : "",
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
            <FieldLabel>
              {t("reasoning.enterprise.profile", { defaultValue: "Profile Name" })}
            </FieldLabel>
            <Input
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
            <FieldLabel>
              {t("reasoning.enterprise.accessKeyId", { defaultValue: "Access Key ID" })}
            </FieldLabel>
            <ApiKeyInput
              apiKey={store.bedrockAccessKeyId}
              setApiKey={store.setBedrockAccessKeyId}
              label=""
              placeholder="AKIA..."
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel>
              {t("reasoning.enterprise.secretAccessKey", { defaultValue: "Secret Access Key" })}
            </FieldLabel>
            <ApiKeyInput
              apiKey={store.bedrockSecretAccessKey}
              setApiKey={store.setBedrockSecretAccessKey}
              label=""
            />
          </div>
          <div className="space-y-1.5">
            <FieldLabel>
              {t("reasoning.enterprise.sessionToken", {
                defaultValue: "Session Token (optional)",
              })}
            </FieldLabel>
            <Input
              value={store.bedrockSessionToken}
              onChange={(e) => store.setBedrockSessionToken(e.target.value)}
              placeholder=""
              className="text-sm"
            />
          </div>
        </div>
      )}

      <div className="space-y-1.5">
        <FieldLabel>{t("reasoning.enterprise.region", { defaultValue: "Region" })}</FieldLabel>
        <select
          value={store.bedrockRegion}
          onChange={(e) => store.setBedrockRegion(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {BEDROCK_REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
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

      <TestConnectionButton provider="bedrock" getConfig={getTestConfig} />
    </div>
  );
}

function AzureConfig({ reasoningModel, setReasoningModel }: EnterpriseProviderConfigProps) {
  const { t } = useTranslation();
  const store = useSettingsStore();

  const getTestConfig = () => ({
    azureEndpoint: store.azureEndpoint,
    azureApiVersion: store.azureApiVersion,
    apiKey: store.azureApiKey,
    model: store.azureDeploymentName || reasoningModel,
  });

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <FieldLabel>
          {t("reasoning.enterprise.endpoint", { defaultValue: "Endpoint URL" })}
        </FieldLabel>
        <Input
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
        <FieldLabel>API Key</FieldLabel>
        <ApiKeyInput apiKey={store.azureApiKey} setApiKey={store.setAzureApiKey} label="" />
      </div>

      <div className="space-y-1.5">
        <FieldLabel>
          {t("reasoning.enterprise.deploymentName", { defaultValue: "Deployment Name" })}
        </FieldLabel>
        <Input
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
        <FieldLabel>
          {t("reasoning.enterprise.apiVersion", { defaultValue: "API Version" })}
        </FieldLabel>
        <Input
          value={store.azureApiVersion}
          onChange={(e) => store.setAzureApiVersion(e.target.value)}
          placeholder="2024-10-21"
          className="text-sm font-mono"
        />
      </div>

      <TestConnectionButton provider="azure" getConfig={getTestConfig} />
    </div>
  );
}

function VertexConfig({ reasoningModel, setReasoningModel }: EnterpriseProviderConfigProps) {
  const { t } = useTranslation();
  const store = useSettingsStore();
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
          <FieldLabel>API Key</FieldLabel>
          <ApiKeyInput
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
        <FieldLabel>
          {t("reasoning.enterprise.projectId", { defaultValue: "Project ID" })}
        </FieldLabel>
        <Input
          value={store.vertexProject}
          onChange={(e) => store.setVertexProject(e.target.value)}
          placeholder="my-gcp-project-123"
          className="text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <FieldLabel>{t("reasoning.enterprise.location", { defaultValue: "Location" })}</FieldLabel>
        <select
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

      <TestConnectionButton provider="vertex" getConfig={getTestConfig} />
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
