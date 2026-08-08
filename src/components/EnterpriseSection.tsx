import { useTranslation } from "react-i18next";
import { ProviderTabs } from "./ui/ProviderTabs";
import EnterpriseProviderConfig from "./EnterpriseProviderConfig";
import { REASONING_PROVIDERS } from "../models/ModelRegistry";
import { useSettingsStore } from "../stores/settingsStore";
import { adjustBedrockModelForRegion } from "../utils/bedrockRegions";
import { isEnterpriseProviderAllowed } from "../stores/policyRules";
import { usePolicySnapshot } from "../hooks/usePolicy";

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

export default function EnterpriseSection({
  currentProvider,
  reasoningModel,
  setReasoningModel,
  setLocalReasoningProvider,
}: EnterpriseSectionProps) {
  const { t } = useTranslation();
  const azureDeploymentName = useSettingsStore((s) => s.azureDeploymentName);
  const bedrockRegion = useSettingsStore((s) => s.bedrockRegion);
  const policyState = usePolicySnapshot();
  const providerAllowed = (providerId: string) =>
    isEnterpriseProviderAllowed(policyState, providerId);

  const providerTabs = ENTERPRISE_PROVIDER_TABS.map((tab) =>
    providerAllowed(tab.id)
      ? tab
      : { ...tab, disabled: true, disabledLabel: t("common.managedByOrg") }
  );
  const selectedEnterprise = ENTERPRISE_PROVIDER_TABS.some((p) => p.id === currentProvider)
    ? currentProvider
    : "";

  const handleEnterpriseSelect = (providerId: string) => {
    if (selectedEnterprise === providerId) return;
    if (!providerAllowed(providerId)) return;
    setLocalReasoningProvider(providerId);

    const providerData = REASONING_PROVIDERS[providerId];
    if (providerData?.models?.length) {
      const defaultModel = providerData.models[0].value;
      setReasoningModel(
        providerId === "bedrock"
          ? adjustBedrockModelForRegion(defaultModel, bedrockRegion)
          : defaultModel
      );
    } else if (providerId === "azure" && azureDeploymentName) {
      setReasoningModel(azureDeploymentName);
    }
  };

  return (
    <div className="space-y-2">
      <ProviderTabs
        providers={providerTabs}
        selectedId={selectedEnterprise}
        onSelect={handleEnterpriseSelect}
        colorScheme="purple"
      />

      {selectedEnterprise && (
        <EnterpriseProviderConfig
          provider={selectedEnterprise as "bedrock" | "azure" | "vertex"}
          reasoningModel={reasoningModel}
          setReasoningModel={setReasoningModel}
        />
      )}
    </div>
  );
}
