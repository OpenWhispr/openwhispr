import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";

/** Where a GitHub user removes an App's authorization. */
export const GITHUB_AUTHORIZATIONS_URL = "https://github.com/settings/apps/authorizations";

/**
 * Shown after Disconnect, which only deletes the login on this computer
 * (see githubConnector's revoke): the authorization stays on github.com
 * until the user removes it there.
 */
export function GithubReviewAccess(): ReactElement {
  const { t } = useTranslation();
  return (
    <p className="text-xs text-muted-foreground/70 mt-1 leading-relaxed">
      {t("connectors.github.disconnectedHint")}{" "}
      <Button
        size="sm"
        variant="link"
        className="h-auto p-0"
        onClick={() => void window.electronAPI?.openExternal?.(GITHUB_AUTHORIZATIONS_URL)}
      >
        {t("connectors.github.reviewOnGithub")}
      </Button>
    </p>
  );
}
