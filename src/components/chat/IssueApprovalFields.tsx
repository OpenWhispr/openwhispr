import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
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

/** An issue's title and description, or a comment's text, shown or edited. */
export function IssueApprovalFields({
  verb,
  fields,
  editing,
  problem,
  problemsId,
  onChange,
}: IssueApprovalFieldsProps): ReactElement {
  const { t } = useTranslation();
  const hasTitle = verb === "issue";
  const titleInvalid = problem !== null && TITLE_PROBLEMS.has(problem);
  const bodyInvalid = problem !== null && !titleInvalid;
  const validity = (isInvalid: boolean): { "aria-invalid"?: true; "aria-describedby"?: string } =>
    isInvalid ? { "aria-invalid": true, "aria-describedby": problemsId } : {};

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
          {...validity(titleInvalid)}
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
        {...validity(bodyInvalid)}
        className={`min-h-24 ${FIELD_CLASS}`}
        dir="auto"
        value={fields.body}
        onChange={(event) => onChange({ body: event.target.value })}
      />
    </div>
  );
}
