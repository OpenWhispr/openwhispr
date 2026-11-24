import { useEffect, useState } from "react";
import { subscribeAuthBoundary } from "../../../lib/authRequestContext";
import {
  parsePlansBillingTarget,
  type PlansBillingRequest,
  type SettingsSectionType,
} from "../../../lib/settingsNav";

const PERSONAL: PlansBillingRequest = { kind: "personal" };

/**
 * Which plan Plans & Billing shows. It only ever follows a link or the picker, never the
 * active workspace, and falls back to Personal whenever the page is entered again or the
 * account changes, so a view never outlives the visit or the account it was picked in.
 */
export function usePlansBillingRequest(
  initialSection: string | undefined,
  activeSection: SettingsSectionType
): [PlansBillingRequest, (request: PlansBillingRequest) => void] {
  const [request, setRequest] = useState<PlansBillingRequest>(
    () => parsePlansBillingTarget(initialSection) ?? PERSONAL
  );
  const [previousSection, setPreviousSection] = useState(activeSection);
  if (activeSection !== previousSection) {
    setPreviousSection(activeSection);
    if (activeSection === "plansBilling") setRequest(PERSONAL);
  }

  useEffect(() => subscribeAuthBoundary(() => setRequest(PERSONAL)), []);

  return [request, setRequest];
}
