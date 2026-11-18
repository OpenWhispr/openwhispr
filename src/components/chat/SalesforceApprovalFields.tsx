import { useId, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { SalesforcePreviewField } from "../../types/connectors";
import { Checkbox } from "../ui/checkbox";
import { INLINE_TEXT_FIELD } from "./interactions/cardStyles";

export function SalesforceApprovalFields({
  definitions,
  fields,
  editing,
  problemsId,
  onChange,
}: {
  definitions: SalesforcePreviewField[];
  fields: Record<string, string | string[]>;
  editing: boolean;
  problemsId: string;
  onChange: (patch: Record<string, string>) => void;
}): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="space-y-4">
      {definitions.map((definition, index) => {
        const included = fields[`include${index}`] === "yes";
        const value =
          typeof fields[definition.key] === "string" ? (fields[definition.key] as string) : "";
        const tooLong = included && value.length > definition.maxLength;
        const fieldName = (
          <>
            <span className="font-medium">{definition.label}</span>{" "}
            <span className="text-xs text-muted-foreground">({definition.name})</span>
          </>
        );
        const legendId = `${id}-${index}-legend`;
        const labelId = `${id}-${index}-label`;
        return (
          <fieldset key={definition.key} className="space-y-1">
            {/* Names the group, and with the label below each replacement box. */}
            <legend id={legendId} className="sr-only">
              {definition.label}
            </legend>
            {editing ? (
              <Checkbox
                checked={included}
                onChange={(checked) => onChange({ [`include${index}`]: checked ? "yes" : "no" })}
                ariaLabel={t("connectors.approval.salesforce.include", {
                  field: `${definition.label} (${definition.name})`,
                })}
                className="py-0.5 agent:min-h-0 agent:py-0.5"
              >
                {fieldName}
              </Checkbox>
            ) : (
              <p dir="auto">
                {fieldName}
                {!included && (
                  <span className="ms-1 text-xs text-muted-foreground">
                    {t("connectors.approval.salesforce.omitted")}
                  </span>
                )}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("connectors.approval.salesforce.before")}
            </p>
            <p className="whitespace-pre-wrap break-words text-muted-foreground" dir="auto">
              {definition.before || t("connectors.approval.salesforce.empty")}
            </p>
            <label
              id={labelId}
              htmlFor={`${id}-${index}`}
              className="block text-xs text-muted-foreground"
            >
              {t("connectors.approval.salesforce.after")}
            </label>
            {editing ? (
              <textarea
                id={`${id}-${index}`}
                aria-labelledby={`${legendId} ${labelId}`}
                aria-invalid={tooLong || undefined}
                aria-describedby={tooLong ? problemsId : undefined}
                disabled={!included}
                className={`${INLINE_TEXT_FIELD} disabled:opacity-50`}
                dir="auto"
                value={value}
                onChange={(event) => onChange({ [definition.key]: event.target.value })}
              />
            ) : (
              <p className="whitespace-pre-wrap break-words" dir="auto">
                {value || t("connectors.approval.salesforce.empty")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {t("connectors.approval.salesforce.limit", {
                count: value.length,
                max: definition.maxLength,
              })}
            </p>
          </fieldset>
        );
      })}
    </div>
  );
}
