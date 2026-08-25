import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

export interface ManagedSetupBlockedActionsProps {
  onRetry: () => void;
  onSignOut: () => void;
}

export function ManagedSetupBlockedActions({
  onRetry,
  onSignOut,
}: ManagedSetupBlockedActionsProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <Button type="button" variant="outline" onClick={onSignOut}>
        {t("settingsPage.account.signOut.signOut")}
      </Button>
      <Button type="button" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}
