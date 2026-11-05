import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { useInviteSeatLines } from "../../hooks/useInviteSeatLines";
import { workspaceCan } from "../../lib/capabilities";
import { seatsWarningMessage, shortfall } from "../../lib/inviteFlow";
import { WorkspaceErrorBar } from "../workspace/WorkspaceErrorBar";

interface SpaceInviteSeatNoticeProps {
  workspaceId: string;
  /** The new addresses staged in the teamspace's people field. */
  addressCount: number;
}

// What the invite dialog says about seats, for the fields that invite addresses without opening
// it. Like there, it only warns: the server bills a seat when an invitation is accepted.
export function SpaceInviteSeatNotice({
  workspaceId,
  addressCount,
}: SpaceInviteSeatNoticeProps): ReactElement | null {
  const { t } = useTranslation();
  const { workspace, purchasedLeft, seatLine, seatCostLine } = useInviteSeatLines(
    workspaceId,
    true,
    addressCount
  );
  const overSeats = shortfall(purchasedLeft, addressCount);
  if (!overSeats && !seatLine && !seatCostLine) return null;
  const canManageBilling = workspaceCan(workspace, "manage_billing");

  return (
    <div className="space-y-1.5">
      {overSeats ? (
        <WorkspaceErrorBar
          tone="warning"
          message={seatsWarningMessage(
            t,
            overSeats,
            canManageBilling,
            workspace?.billing_manager ?? null
          )}
          action={
            canManageBilling
              ? {
                  label: t("workspaces.invite.upgrade"),
                  // A named section remounts Settings, which takes this field's dialog with it.
                  onClick: () => void window.electronAPI?.openSettingsSection?.("plansBilling"),
                }
              : undefined
          }
        />
      ) : null}
      {seatLine ? <p className="text-xs text-muted-foreground">{seatLine}</p> : null}
      {seatCostLine ? <p className="text-xs text-muted-foreground">{seatCostLine}</p> : null}
    </div>
  );
}
