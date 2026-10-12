import type { ComponentType, ReactNode } from "react";
import gmailMark from "../../assets/icons/gmail.svg";
import slackMark from "../../assets/icons/slack.svg";
import linearMark from "../../assets/icons/linear.svg";
import githubMark from "../../assets/icons/github.svg";
import type { ConnectorStatus } from "../../types/connectors";
import { GithubDeviceCode } from "./GithubDeviceCode";
import { GithubRepositoriesButton } from "./GithubRepositoriesButton";
import { GithubReviewAccess } from "./GithubReviewAccess";

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
  /** Buttons beside Disconnect while connected (GitHub's Choose or Manage repositories). */
  rowActions?: ComponentType<{ status: ConnectorStatus }>;
  /** Shown after this row's Disconnect, until the next Connect (GitHub's Review on GitHub). */
  disconnectedDetail?: ComponentType<{ connectorId: string }>;
  /**
   * The connect runs in the row (GitHub's device code) rather than a browser
   * round trip: the row's detail has its own Cancel, Connect isn't offered
   * again while it waits (a new code would silently replace one the user may
   * have typed), and it stops when the row goes away (the user left Settings).
   */
  connectInRow?: boolean;
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

/** A brand mark for a white tile; `className` sets its size (and `icon-monochrome` for one-colour marks). */
function brandMark(src: string, width: number, height: number, className: string): ReactNode {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={width}
      height={height}
      decoding="async"
      draggable={false}
      className={`shrink-0 select-none ${className}`}
    />
  );
}

const githubRow: ConnectorRowSpec = {
  id: "github",
  brandIcon: true,
  // GitHub's mark is black only; icon-monochrome inverts it in dark mode.
  icon: brandMark(githubMark, 18, 18, "h-[18px] w-[18px] icon-monochrome"),
  // getStatus reports the installed repository count as workspaceLabel, or
  // null when the installations couldn't be read. The i18next context picks
  // connectedAs_empty ("no repositories yet") or connectedAs_unknown (no
  // count), which also stands in until the first count is read.
  accountSummary: (status) => {
    const account = status.accountLabel ?? "";
    const count = status.workspaceLabel;
    if (count === null || status.workspaceLabelPending) return { account, context: "unknown" };
    return count === "0" ? { account, context: "empty" } : { account, repositories: count };
  },
  connectingDetail: GithubDeviceCode,
  rowActions: GithubRepositoriesButton,
  disconnectedDetail: GithubReviewAccess,
  // GitHub polls for up to 15 minutes; leaving Settings means the user gave up.
  connectInRow: true,
};

/** Every connector login row, in the order Settings shows them. New connectors append here. */
export const CONNECTOR_ROWS: readonly ConnectorRowSpec[] = [
  {
    id: "gmail",
    // Gmail's mark, like the calendar rows' brand marks: the generic
    // envelope is the "Email drafts" row just above.
    brandIcon: true,
    icon: brandMark(gmailMark, 20, 15, "h-[15px] w-5"),
    accountSummary: accountLabelSummary,
  },
  {
    id: "slack",
    brandIcon: true,
    icon: brandMark(slackMark, 18, 18, "h-[18px] w-[18px]"),
    accountSummary: accountWorkspaceSummary,
  },
  {
    id: "linear",
    brandIcon: true,
    // Linear's mark is one colour; icon-monochrome inverts it in dark mode.
    icon: brandMark(linearMark, 16, 16, "h-4 w-4 icon-monochrome"),
    accountSummary: accountWorkspaceSummary,
  },
  githubRow,
];
