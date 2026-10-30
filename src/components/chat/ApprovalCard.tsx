import { useId, useRef, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, CopyRounded, ExternalLink, Send } from "../icons";
import { cn } from "../lib/utils";
import {
  approveAction,
  cancelApproval,
  connectToSend,
  dismissReconnect,
  retryApproval,
  updateApprovalDraft,
  type ApprovalEntry,
} from "../../stores/connectorApprovalStore";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { connectorErrorText } from "../../utils/connectorErrorCopy";
import { CONNECTION_TARGET_NAMES } from "../../config/agentCapabilities";
import type { ConnectionTarget } from "../../types/agentInteractions";
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
import { ConnectRow } from "./interactions/ConnectionCard";
import { HeaderRow } from "./interactions/HeaderRow";
import {
  INLINE_TEXT_FIELD,
  INLINE_TITLE_FIELD,
  PILL_BUTTON,
  PRIMARY_PILL_BUTTON,
} from "./interactions/cardStyles";
import slackMark from "../../assets/icons/slack.svg";

export const APPROVAL_CARD_CLASS =
  "my-1.5 rounded-lg border border-border/70 bg-surface-2/60 p-3 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** The message body: edited in place while the card can still send it. */
function BodyField({
  value,
  editing,
  label,
  invalidBecause,
  onChange,
}: {
  value: string;
  editing: boolean;
  label: string;
  /** The id of the text saying why Send is blocked, when the body is the reason. */
  invalidBecause?: string;
  onChange: (value: string) => void;
}): ReactElement {
  return editing ? (
    <textarea
      data-approval-field="body"
      aria-label={label}
      {...(invalidBecause ? { "aria-invalid": true, "aria-describedby": invalidBecause } : {})}
      dir="auto"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={INLINE_TEXT_FIELD}
    />
  ) : (
    <p
      className="whitespace-pre-wrap break-words leading-6 text-foreground agent:leading-snug"
      dir="auto"
    >
      {value}
    </p>
  );
}

/**
 * An outside action waiting on the user: who it goes to and as whom, the
 * message (edited in place, scrolling inside the card when long), and Copy,
 * Cancel and Send. It keeps the message through Sending and after Sent, and
 * after a failure the draft is editable again with Retry. When Send needs the
 * service connected first, the card asks for that in place of its actions.
 * The draft lives in the store, so Send commits exactly what the card shows.
 */
export function ApprovalCard({ entry }: { entry: ApprovalEntry }): ReactElement {
  const { t } = useTranslation();
  const { preview, draft } = entry;
  const cardRef = useRef<HTMLDivElement>(null);
  const pending = entry.state === "pending";
  const waitingForRetry = Boolean(entry.awaitingRetry);
  // The draft is editable while it can still go out: before Send, or after a
  // failure while Retry waits.
  const editing = (pending && !entry.reconnect) || waitingForRetry;
  // An email card lays out its fields; a malformed one without them falls
  // back to the plain layout rather than showing empty fields.
  const emailFields =
    preview.verbKey === "email" && draft.fields ? toEmailFields(draft.fields) : null;
  // So does an issue or comment card, with its title and body.
  const verb = issueVerb(preview.verbKey);
  const issueFields = verb && draft.fields ? toIssueFields(draft.fields, verb) : null;
  const slack = preview.verbKey === "slackPost";
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
  // Copy takes the message itself, as the card shows it now.
  const body = emailFields?.body ?? issueFields?.body ?? draft.body;
  const { copied, copyText, confirmCopied } = useCopyFeedback(body);

  // Each layout names its own button and outcomes ("Create issue",
  // "Created ENG-124"); every other card keeps Send and "Sent to …".
  const sendLabel = t(`connectors.approval.sendLabel.${preview.verbKey}`, {
    defaultValue: t("connectors.approval.send"),
  });
  const sentRef = verb ? issueSentCopy(verb, destination, entry.resultLabel) : null;
  const sentText = sentRef
    ? t(sentRef.key, sentRef.values)
    : entry.outsideThread
      ? t("connectors.approval.slack.sentOutsideThread", { destination })
      : t("connectors.approval.sent", { destination });
  const unknownRef = verb ? issueUnknownCopy(verb, destination) : null;
  const unknownText = emailFields
    ? t("connectors.approval.email.unknown")
    : unknownRef
      ? t(unknownRef.key, unknownRef.values)
      : t("connectors.approval.unknown", { destination });

  // Send and Cancel remove the button that had focus; the card keeps it, so
  // keyboard and screen-reader users land on the result.
  const focusCardAnd = (action: () => unknown): void => {
    cardRef.current?.focus({ preventScroll: true });
    void action();
  };
  // Esc in a field or on a button must not reach the agent window, whose Esc
  // cancels the whole turn and withdraws the card.
  const keepEscape = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") event.stopPropagation();
  };
  const openLink = (url: string): void => {
    void window.electronAPI?.openExternal?.(url);
  };
  // A connector with its own label names where the link goes ("Open in
  // Gmail"); any other keeps "Open".
  const openLabel = t(`connectors.approval.openIn.${entry.connectorId}`, {
    defaultValue: t("connectors.approval.open"),
  });
  const setBody = (value: string) =>
    updateApprovalDraft(entry.key, draft.fields ? { fields: { body: value } } : { body: value });

  const header = emailFields ? (
    <EmailApprovalFields
      fields={emailFields}
      editing={editing}
      showCc={emailFields.cc.length > 0 || (preview.fields?.cc?.length ?? 0) > 0}
      accountLabel={preview.accountLabel}
      problems={problems}
      problemsId={problemsId}
      onChange={(patch) => updateApprovalDraft(entry.key, { fields: patch })}
    />
  ) : slack ? (
    <>
      <HeaderRow label={t("connectors.approval.slack.channelLabel")}>
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-foreground" dir="auto">
          <img
            src={slackMark}
            alt=""
            aria-hidden="true"
            width={14}
            height={14}
            decoding="async"
            draggable={false}
            className="shrink-0"
          />
          <span className="truncate">
            {preview.workspaceLabel
              ? t("connectors.approval.slack.destination", {
                  workspace: preview.workspaceLabel,
                  destination,
                })
              : destination}
          </span>
        </span>
      </HeaderRow>
      <HeaderRow label={t("connectors.approval.slack.asLabel")}>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground" dir="auto">
          {preview.accountLabel}
        </span>
      </HeaderRow>
    </>
  ) : (
    <>
      <p className="font-medium text-foreground">
        {t(`connectors.approval.headers.${preview.verbKey}`, {
          destination,
          defaultValue: t("connectors.approval.headers.default", { destination }),
        })}
      </p>
      <p className="text-xs text-muted-foreground agent:text-[13px]">
        {preview.workspaceLabel
          ? t("connectors.approval.identityWithWorkspace", {
              account: preview.accountLabel,
              workspace: preview.workspaceLabel,
            })
          : t("connectors.approval.identity", { account: preview.accountLabel })}
      </p>
    </>
  );

  const message =
    issueFields && verb ? (
      <IssueApprovalFields
        connectorId={entry.connectorId}
        pending={editing}
        verb={verb}
        fields={issueFields}
        editing={editing}
        problem={issueProblem}
        problemsId={problemsId}
        onChange={(patch) => updateApprovalDraft(entry.key, { fields: patch })}
      />
    ) : (
      <>
        {draft.title !== undefined &&
          (editing ? (
            <input
              aria-label={t("connectors.approval.titleLabel")}
              className={INLINE_TITLE_FIELD}
              dir="auto"
              value={draft.title}
              onChange={(event) => updateApprovalDraft(entry.key, { title: event.target.value })}
            />
          ) : (
            <p className="mb-1 font-medium" dir="auto">
              {draft.title}
            </p>
          ))}
        <BodyField
          value={body}
          editing={editing}
          label={t(
            emailFields ? "connectors.approval.email.bodyLabel" : "connectors.approval.bodyLabel"
          )}
          invalidBecause={problems?.bodyTooLong ? problemsId : undefined}
          onChange={setBody}
        />
      </>
    );

  const copyButton = (
    <button
      type="button"
      onClick={() => void copyText(body).then((done) => done && confirmCopied(body))}
      className={PILL_BUTTON}
    >
      {copied ? <Check size={14} className="text-success" /> : <CopyRounded size={14} />}
      {t(copied ? "common.copied" : "common.copy")}
    </button>
  );
  const outcomeLink = (entry.state === "sent" || entry.state === "unknown") && entry.url && (
    <button
      type="button"
      onClick={() => openLink(entry.url as string)}
      className="me-auto inline-flex items-center gap-1 rounded-sm text-xs font-medium text-primary hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-ring/40 agent:text-[13px]"
    >
      <ExternalLink size={12} />
      {openLabel}
    </button>
  );

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      data-approval-card={entry.key}
      data-state={entry.state}
      onKeyDown={keepEscape}
      className="my-1.5 flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-surface-1 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-ring agent:border-border agent:text-[15px]"
    >
      <div className="space-y-1 px-4 pt-3 pb-2.5 agent:space-y-0.5">{header}</div>
      <div className="border-t border-border/50 agent:border-border" />
      {/* A long message scrolls here; who it goes to and the actions stay put. */}
      <div
        data-approval-body=""
        className="agent-chat-scroll max-h-44 overflow-y-auto px-4 py-3 text-[14px] agent:text-[15px]"
      >
        {message}
      </div>

      <div className="px-4">
        {hasFieldLayout && editing && (
          <>
            <p
              id={problemsId}
              className="pb-1 text-xs text-destructive empty:hidden agent:text-[13px]"
            >
              {problemText}
            </p>
            {/* Always present while editable, so each new reason is heard. */}
            <p aria-live="polite" className="sr-only">
              {problemAnnouncement}
            </p>
          </>
        )}
        {preview.notes
          ?.filter(
            (note) =>
              !entry.outsideThread || note.key !== "connectors.approval.slack.notes.replyInThread"
          )
          .map((note) => (
            <p
              key={note.key}
              className="pb-1 text-xs text-muted-foreground agent:text-[13px]"
              dir="auto"
            >
              {/* Some note copy (issue.notes.droppedLabels) interpolates the
                card's destination, which connectors don't themselves send in
                note values — the note's own values win on conflict. */}
              {t(note.key, { destination, ...note.values })}
            </p>
          ))}
        {/* One live region for every outcome, rendered from the start so a
            screen reader announces each change. */}
        <div role="status" aria-live="polite" className="text-xs agent:text-[13px]">
          {pending && entry.notice === "policy_retry" && (
            <p className="pb-1 text-muted-foreground">{t("connectors.approval.policyRetry")}</p>
          )}
          {pending && entry.notice === "identity_changed" && (
            <p className="pb-1 text-muted-foreground" dir="auto">
              {t("connectors.approval.identityChanged", { account: preview.accountLabel })}
            </p>
          )}
          {entry.state === "committing" && (
            <p className="sr-only">{t("connectors.approval.sending")}</p>
          )}
          {entry.state === "sent" && (
            <p className={entry.outsideThread ? "pb-1 text-foreground" : "sr-only"}>{sentText}</p>
          )}
          {/* Translated copy only: entry.message is the connector's English,
              written for the model. */}
          {entry.state === "failed" && (
            <p className="pb-1 text-destructive">
              {t("connectors.approval.failed", {
                message: connectorErrorText(t, "approval", entry.connectorId, entry.errorCode, {
                  destination,
                  max: MAX_EMAIL_RECIPIENTS,
                }),
              })}
            </p>
          )}
          {entry.state === "unknown" && <p className="pb-1 text-foreground">{unknownText}</p>}
          {entry.state === "cancelled" && (
            <p className="pb-1 text-muted-foreground">{t("connectors.approval.cancelled")}</p>
          )}
          {entry.state === "not_sent" && (
            <p className="pb-1 text-muted-foreground">{t("connectors.approval.notSent")}</p>
          )}
        </div>
      </div>

      <div className="px-3 pt-1 pb-3">
        {pending && entry.reconnect ? (
          <ConnectRow
            target={entry.connectorId as ConnectionTarget}
            title={t("connectors.approval.connectToSend", {
              name:
                CONNECTION_TARGET_NAMES[entry.connectorId as ConnectionTarget] ?? entry.connectorId,
            })}
            working={entry.reconnect === "connecting"}
            error={entry.connectError}
            onConnect={() => void connectToSend(entry.key)}
            onDismiss={() => dismissReconnect(entry.key)}
          />
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {outcomeLink}
            {copyButton}
            {(pending || waitingForRetry) && (
              <button
                type="button"
                onClick={() => focusCardAnd(() => cancelApproval(entry.key))}
                className={cn(PILL_BUTTON, "text-muted-foreground")}
              >
                {t("connectors.approval.cancel")}
              </button>
            )}
            {(pending || entry.state === "committing") && (
              // aria-disabled rather than disabled: Send stays focusable, and
              // says why it can't send.
              <button
                type="button"
                aria-disabled={sendBlocked || entry.state === "committing" || undefined}
                aria-describedby={sendBlocked ? problemsId : undefined}
                onClick={() => {
                  if (sendBlocked || !pending) return;
                  focusCardAnd(() => approveAction(entry.key));
                }}
                className={cn(
                  PRIMARY_PILL_BUTTON,
                  (sendBlocked || !pending) && "cursor-not-allowed opacity-50"
                )}
              >
                <Send size={14} className="rtl:scale-x-[-1]" />
                {pending ? sendLabel : t("connectors.approval.sending")}
              </button>
            )}
            {waitingForRetry && (
              <button
                type="button"
                aria-disabled={sendBlocked || undefined}
                aria-describedby={sendBlocked ? problemsId : undefined}
                onClick={() => {
                  if (sendBlocked) return;
                  focusCardAnd(() => retryApproval(entry.key));
                }}
                className={cn(PRIMARY_PILL_BUTTON, sendBlocked && "cursor-not-allowed opacity-50")}
              >
                {t("common.retry")}
              </button>
            )}
            {entry.state === "sent" && (
              <span className="inline-flex h-8 items-center gap-1.5 px-2 text-[13px] text-muted-foreground agent:text-[14px]">
                <Check size={14} />
                {verb ? sentText : t("connectors.approval.sentLabel")}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
