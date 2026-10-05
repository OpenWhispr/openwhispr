import { useId, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import {
  approveAction,
  cancelApproval,
  updateApprovalDraft,
  type ApprovalEntry,
} from "../../stores/connectorApprovalStore";
import { connectorErrorText } from "../../utils/connectorErrorCopy";
import {
  MAX_EMAIL_RECIPIENTS,
  MAX_EMAIL_SUBJECT_LENGTH,
  recipientsLabel,
} from "../../helpers/connectors/emailCompose";
import {
  emailFieldProblems,
  hasEmailFieldProblem,
  toEmailFields,
} from "../../utils/emailApprovalFields";
import {
  issueFieldProblem,
  issueProblemCopy,
  issueSentCopy,
  issueUnknownCopy,
  issueVerb,
  toIssueFields,
} from "../../utils/issueApprovalFields";
import { EmailApprovalFields } from "./EmailApprovalFields";
import { IssueApprovalFields } from "./IssueApprovalFields";

// The draft lives in the store, so edit mode only changes how it is shown:
// Send always commits exactly what the card displays.
export function ApprovalCard({ entry }: { entry: ApprovalEntry }): ReactElement {
  const { t } = useTranslation();
  const { preview, draft } = entry;
  const [editing, setEditing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  // The fields exist only while the card can still change.
  const showEditor = editing && entry.state === "pending";
  // An email card lays out its fields; a malformed one without them falls
  // back to the plain layout rather than showing empty fields.
  const emailFields =
    preview.verbKey === "email" && draft.fields ? toEmailFields(draft.fields) : null;
  // So does an issue or comment card, with its title and body.
  const verb = issueVerb(preview.verbKey);
  const issueFields = verb && draft.fields ? toIssueFields(draft.fields, verb) : null;
  // Who it goes to follows the user's edits: main's answer once sent,
  // otherwise the card's own To and Cc.
  const destination =
    entry.destinationLabel ??
    ((emailFields && recipientsLabel(emailFields.to, emailFields.cc)) || preview.destinationLabel);
  const problems = emailFields ? emailFieldProblems(emailFields) : null;
  const issueProblem = verb && issueFields ? issueFieldProblem(issueFields, verb) : null;
  // Send commits exactly what the card shows, so it waits until the card
  // holds something the provider would accept.
  const sendBlocked = Boolean(problems && hasEmailFieldProblem(problems)) || issueProblem !== null;
  const problemsId = useId();
  const emailProblemText = !problems
    ? null
    : problems.invalid.length > 0
      ? t("connectors.approval.email.invalidAddress", { address: problems.invalid[0] })
      : problems.missingTo
        ? t("connectors.approval.email.missingTo")
        : problems.tooManyRecipients
          ? t("connectors.approval.email.tooManyRecipients", { max: MAX_EMAIL_RECIPIENTS })
          : problems.subjectTooLong
            ? t("connectors.approval.email.subjectTooLong", { max: MAX_EMAIL_SUBJECT_LENGTH })
            : problems.bodyTooLong
              ? t("connectors.approval.email.bodyTooLong")
              : null;
  const issueProblemRef = verb && issueProblem ? issueProblemCopy(issueProblem, verb) : null;
  const problemText = issueProblemRef
    ? t(issueProblemRef.key, issueProblemRef.values)
    : emailProblemText;
  // Announced by kind, never naming the address being typed, so a screen
  // reader hears each new reason once instead of every partial address.
  const problemAnnouncement =
    problems && problems.invalid.length > 0
      ? t("connectors.approval.email.invalidAddressAnnouncement")
      : problemText;
  const hasFieldLayout = Boolean(emailFields || issueFields);

  // Each layout names its own button and outcomes ("Create issue",
  // "Created ENG-124"); every other card keeps Send and "Sent to …".
  const sendLabel = t(`connectors.approval.sendLabel.${preview.verbKey}`, {
    defaultValue: t("connectors.approval.send"),
  });
  const sentRef = verb ? issueSentCopy(verb, destination, entry.resultLabel) : null;
  const sentText = sentRef
    ? t(sentRef.key, sentRef.values)
    : t("connectors.approval.sent", { destination });
  const unknownRef = verb ? issueUnknownCopy(verb, destination) : null;
  const unknownText = emailFields
    ? t("connectors.approval.email.unknown")
    : unknownRef
      ? t(unknownRef.key, unknownRef.values)
      : t("connectors.approval.unknown", { destination });

  // Send and Cancel remove the button that had focus; the card keeps it, so
  // keyboard and screen-reader users land on the result.
  const leaveEditingAndFocusCard = (): void => {
    setEditing(false);
    cardRef.current?.focus();
  };

  // Esc anywhere on the card while editing (a field, or the Edit button that
  // keeps focus) ends editing and keeps the draft. It must not reach the
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
  // A connector with its own label names where the link goes ("Open in
  // Gmail"); any other keeps "Open".
  const openLabel = t(`connectors.approval.openIn.${entry.connectorId}`, {
    defaultValue: t("connectors.approval.open"),
  });

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-approval-card={entry.key}
      data-state={entry.state}
      onKeyDown={showEditor ? onEditorKeyDown : undefined}
      className="my-1.5 rounded-lg border border-border/70 bg-surface-2/60 p-3 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <p className="font-medium text-foreground">
        {t(`connectors.approval.headers.${preview.verbKey}`, {
          destination,
          defaultValue: t("connectors.approval.headers.default", { destination }),
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {emailFields
          ? t("connectors.approval.email.from", { account: preview.accountLabel })
          : preview.workspaceLabel
            ? t("connectors.approval.identityWithWorkspace", {
                account: preview.accountLabel,
                workspace: preview.workspaceLabel,
              })
            : t("connectors.approval.identity", { account: preview.accountLabel })}
      </p>

      {emailFields ? (
        <div className="mt-2">
          <EmailApprovalFields
            fields={emailFields}
            editing={showEditor}
            problems={problems}
            problemsId={problemsId}
            onChange={(patch) => updateApprovalDraft(entry.key, { fields: patch })}
          />
        </div>
      ) : issueFields && verb ? (
        <div className="mt-2">
          <IssueApprovalFields
            connectorId={entry.connectorId}
            pending={entry.state === "pending"}
            verb={verb}
            fields={issueFields}
            editing={showEditor}
            problem={issueProblem}
            problemsId={problemsId}
            onChange={(patch) => updateApprovalDraft(entry.key, { fields: patch })}
          />
        </div>
      ) : showEditor ? (
        <div className="mt-2 space-y-2">
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

      {hasFieldLayout && entry.state === "pending" && (
        <>
          <p id={problemsId} className="mt-2 text-xs text-destructive empty:mt-0">
            {problemText}
          </p>
          {/* Always present while pending, so each new reason is heard. */}
          <p aria-live="polite" className="sr-only">
            {problemAnnouncement}
          </p>
        </>
      )}

      {preview.notes?.map((note) => (
        <p key={note.key} className="mt-1 text-xs text-muted-foreground" dir="auto">
          {/* Some note copy (issue.notes.droppedLabels) interpolates the
              card's destination, which connectors don't themselves send in
              note values — the note's own values win on conflict. */}
          {t(note.key, { destination, ...note.values })}
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
            {sentText}
            {entry.url && (
              <Button size="sm" variant="link" onClick={() => openLink(entry.url as string)}>
                {openLabel}
              </Button>
            )}
          </p>
        )}
        {/* Translated copy only: entry.message is the connector's English,
            written for the model. */}
        {entry.state === "failed" && (
          <p className="mt-2 text-destructive">
            {t("connectors.approval.failed", {
              message: connectorErrorText(t, "approval", entry.connectorId, entry.errorCode, {
                destination,
                max: MAX_EMAIL_RECIPIENTS,
              }),
            })}
          </p>
        )}
        {entry.state === "unknown" && (
          <p className="mt-2 text-foreground">
            {unknownText}
            {entry.url && (
              <Button size="sm" variant="link" onClick={() => openLink(entry.url as string)}>
                {openLabel}
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
          {/* aria-disabled rather than disabled: Send stays focusable, and
              says why it can't send. */}
          <Button
            size="sm"
            aria-disabled={sendBlocked || undefined}
            aria-describedby={sendBlocked ? problemsId : undefined}
            className={sendBlocked ? "cursor-not-allowed opacity-50" : undefined}
            onClick={() => {
              if (sendBlocked) return;
              // Leaving the editor also means a frozen textarea never looks
              // editable while the draft sends.
              leaveEditingAndFocusCard();
              void approveAction(entry.key);
            }}
          >
            {sendLabel}
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
