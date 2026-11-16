import { useEffect, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import type { ConnectorStatus } from "../../types/connectors";
import { refreshConnectorStatus } from "../../stores/connectorStatusStore";

/**
 * Opens the GitHub App's install page, where the user picks the
 * repositories the assistant can reach. With none picked yet it is the
 * row's next step, so it reads "Choose repositories" and stands out.
 */
export function GithubRepositoriesButton({
  status,
}: {
  status: ConnectorStatus;
}): ReactElement | null {
  const { t } = useTranslation();
  const removeFocusListener = useRef<(() => void) | null>(null);

  // The row's status can be a stale snapshot (ensureConnectorStatus loads
  // only once per window): a fresh read as soon as this button can show
  // picks up an install finished earlier in this same window session.
  useEffect(() => {
    void refreshConnectorStatus();
  }, []);

  // A listener left armed by a click, with the row gone before the window
  // regained focus, is removed too.
  useEffect(() => () => removeFocusListener.current?.(), []);

  const { manageUrl } = status;
  // Only a count of zero: a count that couldn't be read (null) may still
  // have repositories behind it.
  const none = status.workspaceLabel === "0";

  // While no repository is chosen, every return to this window re-reads the
  // count, so an install finished on GitHub's own page shows however the
  // user got there. It stops once a repository is chosen.
  useEffect(() => {
    if (!none || !manageUrl) return;
    const onFocus = (): void => void refreshConnectorStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [none, manageUrl]);

  // No App slug in this build: there is no page to open. Until the first
  // count is read, "Choose" and "Manage" can't be told apart; guessing would
  // swap the button (and its look) a moment later.
  if (!manageUrl || status.workspaceLabelPending) return null;

  const openManage = (): void => {
    void window.electronAPI?.openExternal?.(manageUrl);
    // With none chosen, the listener above already re-reads on return.
    if (none) return;
    // Otherwise one re-read the next time this window regains focus: coming
    // back from GitHub's install page is the moment the count can change.
    removeFocusListener.current?.();
    const onFocus = (): void => void refreshConnectorStatus();
    window.addEventListener("focus", onFocus, { once: true });
    removeFocusListener.current = () => window.removeEventListener("focus", onFocus);
  };

  return (
    <Button size="sm" variant={none ? "default" : "outline"} onClick={openManage}>
      {t(none ? "connectors.github.repositories.choose" : "connectors.github.repositories.manage")}
    </Button>
  );
}
