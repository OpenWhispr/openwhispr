import { useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { recipientLabel } from "../../helpers/connectors/emailCompose";
import {
  parseAddressList,
  type EmailFieldProblems,
  type EmailFields,
} from "../../utils/emailApprovalFields";
import { INLINE_FIELD } from "./interactions/cardStyles";

// A subject is one header line. A pasted line break becomes a space here,
// so the card never shows a subject main would refuse to send.
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

const LABEL_CLASS = "w-16 shrink-0 text-xs text-muted-foreground";

interface EmailApprovalFieldsProps {
  fields: EmailFields;
  /** Inline editing. The card allows it only while the email can still be sent. */
  editing: boolean;
  /** Cc shows when it has addresses (or had them when the card opened). */
  showCc: boolean;
  /** The sending Gmail address, read only. */
  accountLabel: string;
  /** What blocks Send, and the id of the text that says why. */
  problems: EmailFieldProblems | null;
  problemsId: string;
  onChange: (patch: Partial<EmailFields>) => void;
}

// Which fields a problem is about, for aria-invalid.
function invalidFields(
  fields: EmailFields,
  problems: EmailFieldProblems | null
): { to: boolean; cc: boolean; subject: boolean } {
  const hasInvalid = (list: string[]): boolean =>
    Boolean(problems && list.some((address) => problems.invalid.includes(address)));
  const tooMany = Boolean(problems?.tooManyRecipients);
  return {
    to: hasInvalid(fields.to) || Boolean(problems?.missingTo) || tooMany,
    cc: hasInvalid(fields.cc) || tooMany,
    subject: Boolean(problems?.subjectTooLong),
  };
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex min-h-6 items-center gap-2">
      <span className={LABEL_CLASS}>{label}</span>
      {children}
    </div>
  );
}

// A pasted "Name <address>" (Outlook's "Last, First <address>" too) sends to
// the bare address, so the card shows what it resolved to: a typed entry
// read as part of a name can't disappear unnoticed.
function ResolvedAddresses({ addresses }: { addresses: string[] }): ReactElement | null {
  const { t } = useTranslation();
  if (addresses.length === 0) return null;
  return (
    <p className="ps-18 text-xs text-muted-foreground" dir="auto">
      {t("connectors.approval.email.sendsTo", {
        addresses: addresses.map(recipientLabel).join(", "),
      })}
    </p>
  );
}

// Mounted only while editing, so every edit session starts from the draft.
function EmailFieldsEditor({
  fields,
  showCc,
  problems,
  problemsId,
  onChange,
}: Omit<EmailApprovalFieldsProps, "editing" | "accountLabel">): ReactElement {
  const { t } = useTranslation();
  const invalid = invalidFields(fields, problems);
  const validity = (isInvalid: boolean): { "aria-invalid"?: true; "aria-describedby"?: string } =>
    isInvalid ? { "aria-invalid": true, "aria-describedby": problemsId } : {};
  // To and Cc are edited as text: re-joining the parsed list on every
  // keystroke would swallow the comma the user just typed.
  const [toText, setToText] = useState(() => fields.to.join(", "));
  const [ccText, setCcText] = useState(() => fields.cc.join(", "));
  const addressHint = t("connectors.approval.email.addressHint");

  return (
    <>
      <Row label={t("connectors.approval.email.toLabel")}>
        <input
          aria-label={t("connectors.approval.email.toLabel")}
          title={addressHint}
          {...validity(invalid.to)}
          type="text"
          className={INLINE_FIELD}
          dir="auto"
          value={toText}
          onChange={(event) => {
            setToText(event.target.value);
            onChange({ to: parseAddressList(event.target.value) });
          }}
        />
      </Row>
      {toText.includes("<") && <ResolvedAddresses addresses={fields.to} />}
      {showCc && (
        <Row label={t("connectors.approval.email.ccLabel")}>
          <input
            aria-label={t("connectors.approval.email.ccLabel")}
            title={addressHint}
            {...validity(invalid.cc)}
            type="text"
            className={INLINE_FIELD}
            dir="auto"
            value={ccText}
            onChange={(event) => {
              setCcText(event.target.value);
              onChange({ cc: parseAddressList(event.target.value) });
            }}
          />
        </Row>
      )}
      {showCc && ccText.includes("<") && <ResolvedAddresses addresses={fields.cc} />}
      <Row label={t("connectors.approval.email.subjectLabel")}>
        <input
          aria-label={t("connectors.approval.email.subjectLabel")}
          {...validity(invalid.subject)}
          type="text"
          className={`${INLINE_FIELD} font-medium`}
          dir="auto"
          value={fields.subject}
          onChange={(event) => onChange({ subject: singleLine(event.target.value) })}
        />
      </Row>
    </>
  );
}

// Display only: a non-ASCII domain also shows the punycode form it routes to
// (recipientLabel), same as destinationLabel and the tool step, so a
// single-script look-alike domain doesn't pass as the real one. Editing
// still reads and writes the raw address.
function EmailFieldsView({ fields, showCc }: { fields: EmailFields; showCc: boolean }) {
  const { t } = useTranslation();
  const value = (text: string, className = "") => (
    <span className={`min-w-0 flex-1 break-words text-foreground ${className}`} dir="auto">
      {text}
    </span>
  );
  return (
    <>
      <Row label={t("connectors.approval.email.toLabel")}>
        {value(fields.to.map(recipientLabel).join(", "))}
      </Row>
      {showCc && fields.cc.length > 0 && (
        <Row label={t("connectors.approval.email.ccLabel")}>
          {value(fields.cc.map(recipientLabel).join(", "))}
        </Row>
      )}
      <Row label={t("connectors.approval.email.subjectLabel")}>
        {value(fields.subject, "font-medium")}
      </Row>
    </>
  );
}

/** The email card's To, Cc and Subject, shown or edited inline, and who it is from. */
export function EmailApprovalFields({
  editing,
  accountLabel,
  ...props
}: EmailApprovalFieldsProps): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {editing ? (
        <EmailFieldsEditor {...props} />
      ) : (
        <EmailFieldsView fields={props.fields} showCc={props.showCc} />
      )}
      <Row label={t("connectors.approval.email.fromLabel")}>
        <span className="min-w-0 flex-1 truncate text-muted-foreground" dir="auto">
          {accountLabel}
        </span>
      </Row>
    </>
  );
}
