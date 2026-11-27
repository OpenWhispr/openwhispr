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
  // Nothing to say yet: a policy on its way hasn't failed to resolve.
  if (policy.status === "idle" || policy.status === "unmanaged" || policy.status === "loading")
    return null;
  const approvedIds = policy.policy?.[scope].allowedLocalModels;
  const message =
    policy.status === "error"
      ? "models.policy.unresolved"
      : !isPolicyActionAllowed(policy)
        ? "models.policy.versionBlocked"
        : !isModeAllowedByPolicy(policy, scope, "local")
          ? "models.policy.modeBlocked"
          : approvedIds == null
            ? null
            : approvedIds.length === 0
              ? "models.policy.emptyIntersection"
              : !hasSupportedModel
                ? "models.policy.noneSupported"
                : "models.policy.guidance";
  if (!message) return null;

  return (
    <p role="status" className="mt-2 text-xs text-muted-foreground">
      {t(message)}
    </p>
  );
}
