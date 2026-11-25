import type { ApprovalEntry } from "../stores/connectorApprovalStore";
import { emailFieldProblems, hasEmailFieldProblem, toEmailFields } from "./emailApprovalFields";
import { issueFieldProblem, issueVerb, toIssueFields } from "./issueApprovalFields";
import { salesforceFieldProblem } from "./salesforceApprovalFields";

/**
 * A card's fields and whether Send may commit them. Send commits exactly what
 * the card shows, so it waits until the card holds something the provider
 * would accept; the card's button and a spoken yes both ask here.
 */
export function approvalCardFields({ preview, draft }: Pick<ApprovalEntry, "preview" | "draft">) {
  // An email card lays out its fields; a malformed one without them falls
  // back to the plain layout rather than showing empty fields.
  const emailFields =
    preview.verbKey === "email" && draft.fields ? toEmailFields(draft.fields) : null;
  // So does an issue or comment card, with its title and body.
  const verb = issueVerb(preview.verbKey);
  const issueFields = verb && draft.fields ? toIssueFields(draft.fields, verb) : null;
  const problems = emailFields ? emailFieldProblems(emailFields) : null;
  const issueProblem = verb && issueFields ? issueFieldProblem(issueFields, verb) : null;
  const salesforceProblem =
    preview.verbKey === "salesforceFields"
      ? salesforceFieldProblem(preview.salesforceFields, draft.fields)
      : null;
  const sendBlocked =
    salesforceProblem !== null ||
    Boolean(problems && hasEmailFieldProblem(problems)) ||
    issueProblem !== null;
  return { emailFields, verb, issueFields, problems, issueProblem, salesforceProblem, sendBlocked };
}
