import type { ComponentType, ReactNode } from "react";
import gmailMark from "../../assets/icons/gmail.svg";
import { CheckCircle, MessageSquare } from "../icons";
import type { ConnectorStatus } from "../../types/connectors";

/** One connector's row in Settings → Integrations → Connectors. */
export interface ConnectorRowSpec {
  id: string;
  icon: ReactNode;
  /** Values for `connectors.<id>.connectedAs`. */
  accountSummary: (status: ConnectorStatus) => Record<string, string>;
  /** A full-colour brand mark sits on a white tile, like the calendar rows'. */
  brandIcon?: boolean;
  /** Shown under the row's summary while Connect is in progress (GitHub's device code). */
  connectingDetail?: ComponentType<{ connectorId: string }>;
}

export function accountLabelSummary(
  status: Pick<ConnectorStatus, "accountLabel">
): Record<string, string> {
  return { account: status.accountLabel ?? "" };
}

export function accountWorkspaceSummary(
  status: Pick<ConnectorStatus, "accountLabel" | "workspaceLabel">
): Record<string, string> {
  return { account: status.accountLabel ?? "", workspace: status.workspaceLabel ?? "" };
}

const ICON_CLASS = "w-4 h-4 text-primary";

/** Every connector login row, in the order Settings shows them. New connectors append here. */
export const CONNECTOR_ROWS: readonly ConnectorRowSpec[] = [
  {
    id: "gmail",
    // Gmail's mark, like the calendar rows' brand marks: the generic
    // envelope is the "Email drafts" row just above.
    brandIcon: true,
    icon: (
      <img
        src={gmailMark}
        alt=""
        aria-hidden="true"
        width={20}
        height={15}
        decoding="async"
        draggable={false}
        className="h-[15px] w-5 shrink-0 select-none"
      />
    ),
    accountSummary: accountLabelSummary,
  },
  {
    id: "slack",
    icon: <MessageSquare className={ICON_CLASS} aria-hidden="true" />,
    accountSummary: accountWorkspaceSummary,
  },
  {
    id: "linear",
    icon: <CheckCircle className={ICON_CLASS} aria-hidden="true" />,
    accountSummary: accountWorkspaceSummary,
  },
];
