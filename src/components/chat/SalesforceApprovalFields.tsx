import { useId, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { SalesforcePreviewField } from "../../types/connectors";

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
    <div className="space-y-3">
      {definitions.map((definition, index) => {
        const included = fields[`include${index}`] === "yes";
        const value =
          typeof fields[definition.key] === "string" ? (fields[definition.key] as string) : "";
        const tooLong = included && value.length > definition.maxLength;
        return (
          <fieldset
            key={definition.key}
            className="space-y-1 rounded-md border border-border/70 p-2"
          >
            <legend className="px-1 font-medium">
              {definition.label}{" "}
              <span className="text-xs text-muted-foreground">({definition.name})</span>
            </legend>
            {editing ? (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={included}
                  onChange={(event) =>
                    onChange({ [`include${index}`]: event.target.checked ? "yes" : "no" })
                  }
                />
                {t("connectors.approval.salesforce.include", { field: definition.label })}
              </label>
            ) : (
              !included && (
                <p className="text-xs text-muted-foreground">
                  {t("connectors.approval.salesforce.omitted")}
                </p>
              )
            )}
            <p className="text-xs text-muted-foreground">
              {t("connectors.approval.salesforce.before")}
            </p>
            <p className="whitespace-pre-wrap break-words" dir="auto">
              {definition.before || t("connectors.approval.salesforce.empty")}
            </p>
            <label htmlFor={`${id}-${index}`} className="block text-xs text-muted-foreground">
              {t("connectors.approval.salesforce.after")}
            </label>
            {editing ? (
              <textarea
                id={`${id}-${index}`}
                aria-label={t("connectors.approval.salesforce.value", { field: definition.label })}
                aria-invalid={tooLong || undefined}
                aria-describedby={tooLong ? problemsId : undefined}
                disabled={!included}
                className="min-h-20 w-full rounded-md border border-border/70 bg-background px-2 py-1 disabled:opacity-50"
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
