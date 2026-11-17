import type { SalesforcePreviewField } from "../types/connectors";

export type SalesforceFieldProblem = "invalidPreview" | "noneSelected" | "tooLong";

export function salesforceFieldProblem(
  definitions: SalesforcePreviewField[] | undefined,
  fields: Record<string, string | string[]> | undefined
): SalesforceFieldProblem | null {
  if (
    !definitions?.length ||
    definitions.length > 3 ||
    !fields ||
    Object.keys(fields).length !== definitions.length * 2
  )
    return "invalidPreview";
  let selected = 0;
  for (const [index, definition] of definitions.entries()) {
    const value = fields[definition.key];
    const include = fields[`include${index}`];
    if (
      definition.key !== `value${index}` ||
      typeof value !== "string" ||
      (include !== "yes" && include !== "no") ||
      !Number.isSafeInteger(definition.maxLength) ||
      definition.maxLength < 1
    )
      return "invalidPreview";
    if (include === "no") continue;
    selected++;
    if (value.length > definition.maxLength) return "tooLong";
  }
  return selected ? null : "noneSelected";
}

export function salesforceOutcomeKey(
  verbKey: string | undefined,
  outcome: "sent" | "unknown"
): string | null {
  return verbKey === "salesforceActivity" || verbKey === "salesforceFields"
    ? `connectors.approval.salesforce.${verbKey}.${outcome}`
    : null;
}
