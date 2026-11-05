import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { HelpEvidenceData } from "./helpEvidence";
import { helpFactLabel, helpFactValue } from "./helpEvidenceText";

export function HelpEvidence({ evidence }: { evidence: HelpEvidenceData }) {
  const { t, i18n } = useTranslation();
  const [openFailed, setOpenFailed] = useState(false);
  const reasons = [...new Set(evidence.sources.flatMap((source) => source.reason ?? []))];

  return (
    <div className="select-none mt-3 border-t border-border/70 pt-2 text-xs" data-help-evidence>
      <p className="text-muted-foreground">{t("productHelp.guidance")}</p>
      {reasons.map((reason) => (
        <p key={reason} className="mt-1 text-muted-foreground">
          {t(`productHelp.reason.${reason}`)}
        </p>
      ))}
      {evidence.facts.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer font-medium">{t("productHelp.settings")}</summary>
          <p className="mt-1 text-muted-foreground">{t("productHelp.settingsNote")}</p>
          {evidence.readAt && (
            <p className="mt-1 text-muted-foreground">
              {t("productHelp.readAt", { time: new Date(evidence.readAt).toLocaleString() })}
            </p>
          )}
          <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1">
            {evidence.facts.map((fact, index) => (
              <div key={`${fact.key}-${index}`} className="contents">
                <dt className="text-muted-foreground break-words">{helpFactLabel(fact.key, t)}</dt>
                <dd dir="auto" className="break-words">
                  {helpFactValue(fact.value, t, fact.key, i18n?.resolvedLanguage)}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {evidence.sources.length > 0 && (
        <div className="mt-2">
          <p className="font-medium">{t("productHelp.sources")}</p>
          <ul className="mt-1 space-y-1">
            {evidence.sources.map((source) => (
              <li key={source.url}>
                <a
                  href={source.url}
                  className="text-primary underline underline-offset-2 break-words"
                  onClick={async (event) => {
                    event.preventDefault();
                    try {
                      const result = await window.electronAPI?.openExternal(source.url);
                      setOpenFailed(!result?.success);
                    } catch {
                      setOpenFailed(true);
                    }
                  }}
                >
                  {t(`productHelp.topicsList.${source.title}`, { defaultValue: source.title })}
                </a>
                <span className="ms-1 text-muted-foreground">
                  ({t(`productHelp.sourceStatus.${source.source}`)})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {openFailed && (
        <p role="alert" className="mt-1 text-destructive">
          {t("productHelp.openFailed")}
        </p>
      )}
    </div>
  );
}
