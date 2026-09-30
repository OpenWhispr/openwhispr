import { useId, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { liveCardNotesFor } from "./liveCardNotes";
import type { IssueFieldProblem, IssueFields, IssueVerb } from "../../utils/issueApprovalFields";

const FIELD_CLASS = "w-full rounded-md border border-border/70 bg-background px-2 py-1";
const TITLE_PROBLEMS: ReadonlySet<IssueFieldProblem> = new Set(["missingTitle", "titleTooLong"]);

// A title is one line in every tracker. A pasted line break becomes a space
// here, so the card never shows a title main would refuse to send.
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

interface IssueApprovalFieldsProps {
  verb: IssueVerb;
  fields: IssueFields;
  /** True only while a pending card is being edited, so the inputs are never disabled. */
  editing: boolean;
  /** What blocks Send, and the id of the text that says why. */
  problem: IssueFieldProblem | null;
  problemsId: string;
  onChange: (patch: Partial<IssueFields>) => void;
}

type IssueFieldsLayoutProps = IssueApprovalFieldsProps & {
  /** The id of the live notes under the fields, while there are any. */
  notesId?: string;
};

/** An issue's title and description, or a comment's text, shown or edited. */
function IssueFieldsLayout({
  verb,
  fields,
  editing,
  problem,
  problemsId,
  onChange,
  notesId,
}: IssueFieldsLayoutProps): ReactElement {
  const { t } = useTranslation();
  const hasTitle = verb === "issue";
  const titleInvalid = problem !== null && TITLE_PROBLEMS.has(problem);
  const bodyInvalid = problem !== null && !titleInvalid;
  // Both fields are described by the live notes (who Send notifies), and an
  // invalid one by what blocks Send too.
  const description = (
    isInvalid: boolean
  ): { "aria-invalid"?: true; "aria-describedby"?: string } => {
    const describedBy = [isInvalid ? problemsId : null, notesId].filter(Boolean).join(" ");
    return {
      ...(isInvalid ? { "aria-invalid": true } : {}),
      ...(describedBy ? { "aria-describedby": describedBy } : {}),
    };
  };

  if (!editing) {
    return (
      <div>
        {hasTitle && (
          <p className="font-medium break-words" dir="auto">
            {fields.title}
          </p>
        )}
        <p className="whitespace-pre-wrap break-words" dir="auto">
          {fields.body}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {hasTitle && (
        <input
          aria-label={t("connectors.approval.issue.titleLabel")}
          {...description(titleInvalid)}
          type="text"
          className={FIELD_CLASS}
          dir="auto"
          value={fields.title}
          onChange={(event) => onChange({ title: singleLine(event.target.value) })}
        />
      )}
      <textarea
        aria-label={t(
          hasTitle ? "connectors.approval.issue.bodyLabel" : "connectors.approval.comment.bodyLabel"
        )}
        {...description(bodyInvalid)}
        className={`min-h-24 ${FIELD_CLASS}`}
        dir="auto"
        value={fields.body}
        onChange={(event) => onChange({ body: event.target.value })}
      />
    </div>
  );
}

/**
 * The card's fields, then the notes that follow them as the user edits
 * (GitHub's "This will notify @…"). They speak of what Send will do, so
 * they show only while the card is pending. The preview's own notes are
 * fixed at prepare; the card renders them after this.
 */
export function IssueApprovalFields({
  connectorId,
  pending,
  ...props
}: IssueApprovalFieldsProps & { connectorId: string; pending: boolean }): ReactElement {
  const { t, i18n } = useTranslation();
  const notesId = useId();
  const liveNotes = pending ? liveCardNotesFor(connectorId, props.fields, i18n.language) : [];
  const hasNotes = liveNotes.length > 0;
  return (
    <>
      <IssueFieldsLayout {...props} notesId={hasNotes ? notesId : undefined} />
      {hasNotes && (
        <div id={notesId}>
          {liveNotes.map((note) => (
            <p key={note.key} className="mt-1 text-xs text-muted-foreground" dir="auto">
              {t(note.key, note.values)}
            </p>
          ))}
        </div>
      )}
    </>
  );
}
