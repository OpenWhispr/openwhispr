import { useTranslation } from "react-i18next";
import { usePolicySnapshot } from "../../hooks/usePolicy";
import { isModeAllowedByPolicy, isPolicyActionAllowed } from "../../stores/policyRules";
import type { PolicyScope } from "../../types/policy";

export function LocalModelPolicyNotice({
  scope,
  hasSupportedModel,
}: {
  scope: PolicyScope;
  hasSupportedModel: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const policy = usePolicySnapshot();
  if (policy.status === "idle" || policy.status === "unmanaged") return null;
  const unresolved = policy.status === "loading" || policy.status === "error";
  const approvedIds = policy.policy?.[scope].allowedLocalModels;
  const message = unresolved
    ? "models.policy.unresolved"
    : !isPolicyActionAllowed(policy)
      ? "models.policy.versionBlocked"
      : !isModeAllowedByPolicy(policy, scope, "local")
        ? "models.policy.modeBlocked"
        : approvedIds?.length === 0
          ? "models.policy.emptyIntersection"
          : !hasSupportedModel
            ? "models.policy.noneSupported"
            : "models.policy.guidance";

  return <p className="mt-2 text-xs text-muted-foreground">{t(message)}</p>;
}
