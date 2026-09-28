import { useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
  approveAction,
  cancelApproval,
  updateApprovalDraft,
  type ApprovalEntry,
} from "../../stores/connectorApprovalStore";
import { connectorErrorCopyKey } from "../../utils/connectorErrorCopy";

// The draft lives in the store, so edit mode only changes how it is shown:
// Send always commits exactly what the card displays.
export function ApprovalCard({ entry }: { entry: ApprovalEntry }): ReactElement {
  const { t } = useTranslation();
  const { preview, draft } = entry;
  const [editing, setEditing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const destination = preview.destinationLabel;
  // The fields exist only while the card can still change.
  const showEditor = editing && entry.state === "pending";

  // Send and Cancel remove the button that had focus; the card keeps it, so
  // keyboard and screen-reader users land on the result.
  const leaveEditingAndFocusCard = (): void => {
    setEditing(false);
    cardRef.current?.focus();
  };

  // Esc in a field ends editing and keeps the draft. It must not reach the
  // assistant panel, whose Esc cancels the whole turn and withdraws the card.
  const onEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setEditing(false);
  };

  const openLink = (url: string): void => {
    void window.electronAPI?.openExternal?.(url);
  };

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-approval-card={entry.key}
      data-state={entry.state}
      className="my-1.5 rounded-lg border border-border/70 bg-surface-2/60 p-3 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <p className="font-medium text-foreground">
        {t(`connectors.approval.headers.${preview.verbKey}`, {
          destination,
          defaultValue: t("connectors.approval.headers.default", { destination }),
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {preview.workspaceLabel
          ? t("connectors.approval.identityWithWorkspace", {
              account: preview.accountLabel,
              workspace: preview.workspaceLabel,
            })
          : t("connectors.approval.identity", { account: preview.accountLabel })}
      </p>

      {showEditor ? (
        <div className="mt-2 space-y-2" onKeyDown={onEditorKeyDown}>
          {draft.title !== undefined && (
            <input
              aria-label={t("connectors.approval.titleLabel")}
              className="w-full rounded-md border border-border/70 bg-background px-2 py-1"
              dir="auto"
              value={draft.title}
              onChange={(event) => updateApprovalDraft(entry.key, { title: event.target.value })}
            />
          )}
          <textarea
            aria-label={t("connectors.approval.bodyLabel")}
            className="min-h-24 w-full rounded-md border border-border/70 bg-background px-2 py-1"
            dir="auto"
            value={draft.body}
            onChange={(event) => updateApprovalDraft(entry.key, { body: event.target.value })}
          />
        </div>
      ) : (
        <div className="mt-2">
          {draft.title !== undefined && <p className="font-medium">{draft.title}</p>}
          <p className="whitespace-pre-wrap" dir="auto">
            {draft.body}
          </p>
        </div>
      )}

      {preview.notes?.map((note) => (
        <p key={note.key} className="mt-1 text-xs text-muted-foreground">
          {t(note.key, note.values)}
        </p>
      ))}

      {/* One live region for every outcome, rendered from the start so a
          screen reader announces each change. */}
      <div role="status" aria-live="polite" className="text-xs">
        {entry.state === "pending" && entry.notice === "policy_retry" && (
          <p className="mt-2 text-muted-foreground">{t("connectors.approval.policyRetry")}</p>
        )}
        {entry.state === "committing" && (
          <p className="mt-2 text-muted-foreground">{t("connectors.approval.sending")}</p>
        )}
        {entry.state === "sent" && (
          <p className="mt-2 text-foreground">
            {t("connectors.approval.sent", { destination })}
            {entry.url && (
              <Button size="sm" variant="link" onClick={() => openLink(entry.url as string)}>
                {t("connectors.approval.open")}
              </Button>
            )}
          </p>
        )}
        {/* Translated copy only: entry.message is the connector's English,
            written for the model. */}
        {entry.state === "failed" && (
          <p className="mt-2 text-destructive">
            {t("connectors.approval.failed", {
              message: t(`connectors.approval.errors.${connectorErrorCopyKey(entry.errorCode)}`, {
                destination,
                defaultValue: t("connectors.approval.errors.generic"),
              }),
            })}
          </p>
        )}
        {entry.state === "unknown" && (
          <p className="mt-2 text-foreground">
            {t("connectors.approval.unknown", { destination })}
            {entry.url && (
              <Button size="sm" variant="link" onClick={() => openLink(entry.url as string)}>
                {t("connectors.approval.open")}
              </Button>
            )}
          </p>
        )}
        {entry.state === "cancelled" && (
          <p className="mt-2 text-muted-foreground">{t("connectors.approval.cancelled")}</p>
        )}
        {entry.state === "not_sent" && (
          <p className="mt-2 text-muted-foreground">{t("connectors.approval.notSent")}</p>
        )}
      </div>

      {entry.state === "pending" && (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              // Leaving the editor also means a frozen textarea never looks
              // editable while the draft sends.
              leaveEditingAndFocusCard();
              void approveAction(entry.key);
            }}
          >
            {t("connectors.approval.send")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing((value) => !value)}>
            {editing ? t("connectors.approval.doneEditing") : t("connectors.approval.edit")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              leaveEditingAndFocusCard();
              cancelApproval(entry.key);
            }}
          >
            {t("connectors.approval.cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}
