import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { usePolicyStore } from "../../stores/policyStore";
import type { ApiAccessRestriction } from "../../stores/policyRules";

/** Why the organization's policy keeps personal API keys, MCP and cloud CLI from working. */
export function ApiAccessNotice({
  restriction,
}: {
  restriction: ApiAccessRestriction;
}): ReactElement {
  const { t } = useTranslation();
  const minAppVersion = usePolicyStore((state) => state.policy?.minAppVersion ?? null);
  const [title, message] =
    restriction === "disabled"
      ? [t("common.managedByOrg"), t("integrations.apiAccessDisabled")]
      : restriction === "versionBlocked"
        ? [
            t("controlPanel.updateRequiredByOrg.title"),
            t("controlPanel.updateRequiredByOrg.description", { version: minAppVersion }),
          ]
        : [null, t("models.policy.unresolved")];
  return (
    <div role="status" className="space-y-1 rounded-lg border border-border p-3 text-xs">
      {title && <p className="font-medium">{title}</p>}
      <p className="text-muted-foreground">{message}</p>
    </div>
  );
}
