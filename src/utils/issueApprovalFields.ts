/** GitHub's issue title limit; Linear allows more, so one limit fits both. */
export const MAX_ISSUE_TITLE_LENGTH = 256;
/** GitHub's issue and comment body limit; Linear allows more. */
export const MAX_ISSUE_BODY_LENGTH = 65536;

/** The issue-tracker card layouts: a new issue, or a comment on one. */
export type IssueVerb = "issue" | "comment";

/** What the layout shows and Send commits. A comment's title is always "". */
export interface IssueFields {
  title: string;
  body: string;
}

export type IssueFieldProblem = "missingTitle" | "titleTooLong" | "missingBody" | "bodyTooLong";

/** An i18n key and its values, shared by the card and the tool step. */
export interface CopyRef {
  key: string;
  values?: Record<string, string | number>;
}

export function issueVerb(verbKey: string | undefined): IssueVerb | null {
  return verbKey === "issue" || verbKey === "comment" ? verbKey : null;
}

/**
 * The layout's fields from a draft's fields map, or null when the preview
 * didn't carry them; the card then falls back to its plain layout.
 */
export function toIssueFields(
  fields: Record<string, string | string[]>,
  verb: IssueVerb
): IssueFields | null {
  const { title, body } = fields;
  if (typeof body !== "string") return null;
  if (verb === "issue" && typeof title !== "string") return null;
  return { title: typeof title === "string" ? title : "", body };
}

function characterCount(text: string): number {
  return [...text].length;
}

/**
 * The first thing that blocks Send, in the order the card names it. The
 * limits are the strictest tracker's, so a card never ends in a failure the
 * user could have fixed.
 */
export function issueFieldProblem(fields: IssueFields, verb: IssueVerb): IssueFieldProblem | null {
  if (verb === "issue") {
    if (fields.title.trim() === "") return "missingTitle";
    if (characterCount(fields.title) > MAX_ISSUE_TITLE_LENGTH) return "titleTooLong";
  } else if (fields.body.trim() === "") {
    return "missingBody";
  }
  if (characterCount(fields.body) > MAX_ISSUE_BODY_LENGTH) return "bodyTooLong";
  return null;
}

export function issueProblemCopy(problem: IssueFieldProblem, verb: IssueVerb): CopyRef {
  switch (problem) {
    case "missingTitle":
      return { key: "connectors.approval.issue.missingTitle" };
    case "titleTooLong":
      return {
        key: "connectors.approval.issue.titleTooLong",
        values: { max: MAX_ISSUE_TITLE_LENGTH },
      };
    case "missingBody":
      return { key: "connectors.approval.comment.missingBody" };
    case "bodyTooLong":
      return {
        key: `connectors.approval.${verb}.bodyTooLong`,
        values: { max: MAX_ISSUE_BODY_LENGTH },
      };
  }
}

/** What a created issue or posted comment reads as, on the card and in the tool step. */
export function issueSentCopy(verb: IssueVerb, destination: string, resultLabel?: string): CopyRef {
  if (verb === "comment") {
    return { key: "connectors.approval.comment.posted", values: { destination } };
  }
  return resultLabel
    ? { key: "connectors.approval.issue.created", values: { result: resultLabel } }
    : { key: "connectors.approval.issue.createdIn", values: { destination } };
}

export function issueUnknownCopy(verb: IssueVerb, destination: string): CopyRef {
  return { key: `connectors.approval.${verb}.unknown`, values: { destination } };
}
