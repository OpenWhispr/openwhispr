import type { SalesforcePreviewField } from "../types/connectors";

export type SalesforceFieldProblem = "noneSelected" | "tooLong";

export function salesforceFieldProblem(
  definitions: SalesforcePreviewField[] | undefined,
  fields: Record<string, string | string[]> | undefined
): SalesforceFieldProblem | null {
  let selected = 0;
  for (const [index, definition] of (definitions ?? []).entries()) {
    if (fields?.[`include${index}`] !== "yes") continue;
    selected++;
    if (fields[definition.key].length > definition.maxLength) return "tooLong";
  }
  return selected ? null : "noneSelected";
}

/** What Copy takes from a field card: each included field's label and new value. */
export function salesforceFieldsCopyText(
  definitions: SalesforcePreviewField[] | undefined,
  fields: Record<string, string | string[]> | undefined
): string {
  return (definitions ?? [])
    .filter((_definition, index) => fields?.[`include${index}`] === "yes")
    .map((definition) => {
      const value = fields?.[definition.key];
      return `${definition.label}: ${typeof value === "string" ? value : ""}`;
    })
    .join("\n\n");
}

export function salesforceOutcomeKey(
  verbKey: string | undefined,
  outcome: "sent" | "unknown"
): string | null {
  return verbKey === "salesforceActivity" || verbKey === "salesforceFields"
    ? `connectors.approval.salesforce.${verbKey}.${outcome}`
    : null;
}
