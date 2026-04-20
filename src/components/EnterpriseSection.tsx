import { ProviderTabs } from "./ui/ProviderTabs";
import EnterpriseProviderConfig from "./EnterpriseProviderConfig";
import { REASONING_PROVIDERS } from "../models/ModelRegistry";
import { useSettingsStore } from "../stores/settingsStore";

const ENTERPRISE_PROVIDER_TABS = [
  { id: "bedrock", name: "AWS Bedrock" },
  { id: "azure", name: "Azure OpenAI", disabled: true, disabledLabel: "Soon" },
  { id: "vertex", name: "Vertex AI", disabled: true, disabledLabel: "Soon" },
];

interface EnterpriseSectionProps {
  currentProvider: string;
  reasoningModel: string;
  setReasoningModel: (m: string) => void;
  setLocalReasoningProvider: (p: string) => void;
}

// Selected tab is derived from currentProvider. Clicking a tab propagates
// through setLocalReasoningProvider so currentProvider stays authoritative.
export default function EnterpriseSection({
  currentProvider,
  reasoningModel,
  setReasoningModel,
  setLocalReasoningProvider,
}: EnterpriseSectionProps) {
  const azureDeploymentName = useSettingsStore((s) => s.azureDeploymentName);
  const selectedEnterprise = ENTERPRISE_PROVIDER_TABS.some((p) => p.id === currentProvider)
    ? currentProvider
    : "";

  const handleEnterpriseSelect = (providerId: string) => {
    if (selectedEnterprise === providerId) return;
    setLocalReasoningProvider(providerId);

    const providerData = REASONING_PROVIDERS[providerId];
    if (providerData?.models?.length) {
      setReasoningModel(providerData.models[0].value);
    } else if (providerId === "azure" && azureDeploymentName) {
      setReasoningModel(azureDeploymentName);
    }
  };

  return (
    <div className="space-y-2">
      <div className="border border-border rounded-lg overflow-hidden">
        <ProviderTabs
          providers={ENTERPRISE_PROVIDER_TABS}
          selectedId={selectedEnterprise}
          onSelect={handleEnterpriseSelect}
          colorScheme="purple"
        />

        {selectedEnterprise && (
          <div className="p-3">
            <EnterpriseProviderConfig
              provider={selectedEnterprise as "bedrock" | "azure" | "vertex"}
              reasoningModel={reasoningModel}
              setReasoningModel={setReasoningModel}
            />
          </div>
        )}
      </div>
    </div>
  );
}
