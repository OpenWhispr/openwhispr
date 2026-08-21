import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw } from "lucide-react";
import { signOut } from "../../lib/auth";
import { Button } from "../ui/button";

function SignOutButton(): JSX.Element {
  const { t } = useTranslation();
  return (
    <Button type="button" variant="outline" onClick={() => void signOut()}>
      {t("settingsPage.account.signOut.signOut")}
    </Button>
  );
}

export function EnterpriseConfigErrorActions({ onRetry }: { onRetry: () => void }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap justify-center gap-2">
      <SignOutButton />
      <Button type="button" onClick={onRetry}>
        <RotateCcw className="mr-1.5 size-3.5" /> {t("common.retry")}
      </Button>
    </div>
  );
}

export function ManagedSetupFooterActions({
  ready,
  onContinue,
}: {
  ready: boolean;
  onContinue: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="mt-4 flex items-center justify-between gap-2">
      <SignOutButton />
      <Button disabled={!ready} onClick={onContinue}>
        {ready ? t("common.continue") : <Loader2 className="size-4 animate-spin" />}
      </Button>
    </div>
  );
}
