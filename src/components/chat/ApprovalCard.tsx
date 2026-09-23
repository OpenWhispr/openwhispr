import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
  approveAction,
  cancelApproval,
  updateApprovalDraft,
  type ApprovalEntry,
} from "../../stores/connectorApprovalStore";

// The draft lives in the store, so edit mode only changes how it is shown:
// Send always commits exactly what the card displays.
export function ApprovalCard({ entry }: { entry: ApprovalEntry }): ReactElement {
  const { t } = useTranslation();
  const { preview, draft } = entry;
  const [editing, setEditing] = useState(false);
  const destination = preview.destinationLabel;

  return (
    <div
      data-approval-card={entry.toolCallId}
      data-state={entry.state}
      className="my-1.5 rounded-lg border border-border/70 bg-surface-2/60 p-3 text-[13px]"
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

      {editing ? (
        <div className="mt-2 space-y-2">
          {draft.title !== undefined && (
            <input
              aria-label={t("connectors.approval.titleLabel")}
              className="w-full rounded-md border border-border/70 bg-background px-2 py-1"
              value={draft.title}
              onChange={(event) => updateApprovalDraft(entry.toolCallId, { title: event.target.value })}
            />
          )}
          <textarea
            aria-label={t("connectors.approval.bodyLabel")}
            className="min-h-24 w-full rounded-md border border-border/70 bg-background px-2 py-1"
            value={draft.body}
            onChange={(event) => updateApprovalDraft(entry.toolCallId, { body: event.target.value })}
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

      {entry.state === "pending" && (
        <div className="mt-2 flex gap-2">
          <Button size="sm" onClick={() => void approveAction(entry.toolCallId)}>
            {t("connectors.approval.send")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing((value) => !value)}>
            {editing ? t("connectors.approval.doneEditing") : t("connectors.approval.edit")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => cancelApproval(entry.toolCallId)}>
            {t("connectors.approval.cancel")}
          </Button>
        </div>
      )}
      {entry.state === "committing" && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          {t("connectors.approval.sending")}
        </p>
      )}
      {entry.state === "sent" && (
        <p className="mt-2 text-xs text-foreground">
          {t("connectors.approval.sent", { destination })}
          {entry.url && (
            <Button
              size="sm"
              variant="link"
              onClick={() => void window.electronAPI?.openExternal?.(entry.url as string)}
            >
              {t("connectors.approval.open")}
            </Button>
          )}
        </p>
      )}
      {entry.state === "failed" && (
        <p className="mt-2 text-xs text-destructive">
          {t("connectors.approval.failed", { message: entry.message ?? "" })}
        </p>
      )}
      {entry.state === "unknown" && (
        <p className="mt-2 text-xs text-foreground">
          {t("connectors.approval.unknown", { destination })}
          {entry.url && (
            <Button
              size="sm"
              variant="link"
              onClick={() => void window.electronAPI?.openExternal?.(entry.url as string)}
            >
              {t("connectors.approval.open")}
            </Button>
          )}
        </p>
      )}
      {entry.state === "cancelled" && (
        <p className="mt-2 text-xs text-muted-foreground">{t("connectors.approval.cancelled")}</p>
      )}
      {entry.state === "not_sent" && (
        <p className="mt-2 text-xs text-muted-foreground">{t("connectors.approval.notSent")}</p>
      )}
    </div>
  );
}
