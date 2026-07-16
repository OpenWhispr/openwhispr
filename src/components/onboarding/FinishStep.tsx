import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink, Settings, Stethoscope } from "lucide-react";
import { Button } from "../ui/button";
import ApiKeyInput from "../ui/ApiKeyInput";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { getTranscriptionProviders, modelRegistry } from "../../models/ModelRegistry";
import { useSettingsStore } from "../../stores/settingsStore";
import { buildCortiOnboardingPayloads } from "../../helpers/reasoningRouting";
import { USE_CASE_IDS } from "./useCases";

const CORTI_SIGNUP_URL =
  "https://www.corti.ai/?utm_source=referral&utm_content=&utm_campaign=openwhispr";

interface FinishStepProps {
  isCloudUser: boolean;
  useCases: string[];
  onFinish: (openSettings: boolean) => void;
  isFinishing: boolean;
}

export default function FinishStep({
  isCloudUser,
  useCases,
  onFinish,
  isFinishing,
}: FinishStepProps) {
  const { t } = useTranslation();
  const setCloudTranscriptionForAllScopes = useSettingsStore(
    (s) => s.setCloudTranscriptionForAllScopes
  );
  const setCloudReasoningForAllScopes = useSettingsStore((s) => s.setCloudReasoningForAllScopes);
  const cortiClientId = useSettingsStore((s) => s.cortiClientId);
  const setCortiClientId = useSettingsStore((s) => s.setCortiClientId);
  const cortiClientSecret = useSettingsStore((s) => s.cortiClientSecret);
  const setCortiClientSecret = useSettingsStore((s) => s.setCortiClientSecret);
  const cortiApiKey = useSettingsStore((s) => s.cortiApiKey);
  const setCortiApiKey = useSettingsStore((s) => s.setCortiApiKey);
  const cortiEnvironment = useSettingsStore((s) => s.cortiEnvironment);
  const setCortiEnvironment = useSettingsStore((s) => s.setCortiEnvironment);

  // The Corti pitch only renders once the Corti provider ships in the model
  // registry (separate PR) — until then healthcare users see the default finish.
  const cortiProvider = getTranscriptionProviders().find((p) => p.id === "corti");
  const [showCorti, setShowCorti] = useState(
    !!cortiProvider && useCases.includes(USE_CASE_IDS.healthcare)
  );
  const hasCortiCredentials =
    cortiClientId.trim().length > 0 && cortiClientSecret.trim().length > 0;

  const startWithCorti = () => {
    // Transcription always routes to Corti. Reasoning routes to Corti only in the
    // EU with an API key (Corti Models is EU-only); otherwise the HIPAA-compliant
    // OpenWhispr Cloud handles language features so PHI never reaches a third party.
    const reasoningProvider = modelRegistry.getCloudProviders().find((p) => p.id === "corti");
    const { transcription, reasoning } = buildCortiOnboardingPayloads(
      cortiProvider,
      reasoningProvider,
      cortiEnvironment,
      cortiApiKey.trim().length > 0
    );
    setCloudTranscriptionForAllScopes(transcription);
    setCloudReasoningForAllScopes(reasoning);
    onFinish(false);
  };

  if (showCorti) {
    return (
      <div className="space-y-4">
        <div className="text-center space-y-0.5">
          <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-3">
            <Stethoscope className="w-6 h-6 text-primary" />
          </div>
          <h2 className="text-lg font-semibold text-foreground tracking-tight">
            {t("onboarding.finish.corti.title")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("onboarding.finish.corti.description")}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface-1 p-3">
          <button
            onClick={() => window.electronAPI?.openExternal?.(CORTI_SIGNUP_URL)}
            className="inline-flex items-center gap-1 text-xs font-medium text-link hover:underline"
          >
            {t("onboarding.finish.corti.createAccount")}
            <ExternalLink className="w-3 h-3" />
          </button>
          <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded bg-success/10 text-success shrink-0">
            {t("onboarding.finish.corti.creditBadge")}
          </span>
        </div>

        <ol className="list-decimal list-inside space-y-0.5 px-1 text-xs text-muted-foreground">
          <li>{t("onboarding.finish.corti.step1")}</li>
          <li>{t("onboarding.finish.corti.step2")}</li>
          <li>{t("onboarding.finish.corti.step3")}</li>
        </ol>

        <div className="space-y-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              {t("transcription.corti.clientId")}
            </label>
            <ApiKeyInput apiKey={cortiClientId} setApiKey={setCortiClientId} label="" helpText="" />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              {t("transcription.corti.clientSecret")}
            </label>
            <ApiKeyInput
              apiKey={cortiClientSecret}
              setApiKey={setCortiClientSecret}
              label=""
              helpText=""
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">
              {t("transcription.corti.environment")}
            </label>
            <Select value={cortiEnvironment} onValueChange={setCortiEnvironment}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="us">US</SelectItem>
                <SelectItem value="eu">EU</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground/70">
              {t("onboarding.finish.corti.regionHint")}
            </p>
          </div>
          {/* Corti Models (LLM) is EU-only; US projects use OpenWhispr Cloud for
              language features, so the key is only collected in the EU region. */}
          {cortiEnvironment === "eu" && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">
                {t("transcription.corti.apiKey")}
              </label>
              <ApiKeyInput apiKey={cortiApiKey} setApiKey={setCortiApiKey} label="" helpText="" />
              {cortiApiKey.trim() && (
                <p className="text-xs text-muted-foreground/70">
                  {t("onboarding.finish.corti.llmHint")}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowCorti(false)}
            disabled={isFinishing}
            className="h-8 px-5 rounded-full text-xs"
          >
            {t("onboarding.finish.corti.skip")}
          </Button>
          <Button
            onClick={startWithCorti}
            disabled={isFinishing || !hasCortiCredentials}
            className="h-8 px-6 rounded-full text-xs"
          >
            <Check className="w-3.5 h-3.5" />
            {t("onboarding.finish.corti.useCorti")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-center space-y-0.5">
        <div className="w-12 h-12 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-3">
          <Check className="w-6 h-6 text-green-500" />
        </div>
        <h2 className="text-lg font-semibold text-foreground tracking-tight">
          {t("onboarding.finish.title")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {isCloudUser
            ? t("onboarding.finish.cloudDescription")
            : t("onboarding.finish.localDescription")}
        </p>
      </div>

      <p className="text-xs text-muted-foreground text-center">
        {t("onboarding.finish.cleanupNote")}
      </p>

      <div className="flex items-center justify-center gap-2">
        <Button
          variant="outline"
          onClick={() => onFinish(true)}
          disabled={isFinishing}
          className="h-8 px-5 rounded-full text-xs"
        >
          <Settings className="w-3.5 h-3.5" />
          {t("onboarding.finish.openSettings")}
        </Button>
        <Button
          variant="success"
          onClick={() => onFinish(false)}
          disabled={isFinishing}
          className="h-8 px-6 rounded-full text-xs"
        >
          <Check className="w-3.5 h-3.5" />
          {t("onboarding.finish.skipForNow")}
        </Button>
      </div>
    </div>
  );
}
