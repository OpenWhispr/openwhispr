import { workspacePlanSection, type WorkspacePlanSection } from "../../lib/settingsNav";

// The seat the invitation needs is billed on the workspace being invited to, so its plan view
// opens; without a workspace in the list only the personal plan is left to show.
export function seatNoticeBillingTarget(
  workspace: { id: string } | null | undefined
): "plansBilling" | WorkspacePlanSection {
  return workspace ? workspacePlanSection(workspace.id) : "plansBilling";
}
