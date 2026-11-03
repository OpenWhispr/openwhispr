import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { CompactAuthenticationFlow } from "./CompactAuthenticationFlow";
import OnboardingShell from "./onboarding/OnboardingShell";

interface ReauthenticationScreenProps {
  onContinueWithoutAccount?: () => void;
  onAuthComplete: () => void;
  requiredByDevice?: boolean;
}

export default function ReauthenticationScreen({
  onContinueWithoutAccount,
  onAuthComplete,
  requiredByDevice = false,
}: ReauthenticationScreenProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <OnboardingShell compact stepKey="reauthentication">
      <div className="min-h-full w-full">
        {requiredByDevice && (
          <p className="px-6 pt-4 text-sm text-muted-foreground">
            {t("common.deviceSignInRequired")}
          </p>
        )}
        <CompactAuthenticationFlow
          onContinueWithoutAccount={onContinueWithoutAccount}
          onAuthComplete={onAuthComplete}
        />
      </div>
    </OnboardingShell>
  );
}
