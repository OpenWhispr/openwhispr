import { useTranslation } from "react-i18next";
import type { ConnectionAutoCheck } from "../../hooks/useConnectionAutoCheck";

/**
 * The voice of an automatic connection check, in a Settings panel or the onboarding
 * provider step: "Testing…" for a slow request, "Connected" once per result. It mounts with
 * its panel or step, so the region exists before it speaks, and a panel that TabPanel hides
 * is out of the accessibility tree. In a space-y column, render it first, where a last child
 * would add a margin under the column.
 */
export function ConnectionCheckAnnouncer({
  announcement,
}: Pick<ConnectionAutoCheck, "announcement">) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement === "connected"
        ? t("onboarding.rehaul.provider.connected")
        : announcement === "testing"
          ? t("onboarding.rehaul.provider.testing")
          : ""}
    </div>
  );
}
