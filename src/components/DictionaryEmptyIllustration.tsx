import { useTranslation } from "react-i18next";
import { NotebookPen, PanelRight } from "./icons";

interface DictionaryEmptyIllustrationProps {
  variant: "dictionary" | "snippets";
}

export default function DictionaryEmptyIllustration({ variant }: DictionaryEmptyIllustrationProps) {
  const { t } = useTranslation();
  const isSnippet = variant === "snippets";

  return (
    <div aria-hidden="true" className="absolute inset-y-0 end-0 hidden w-2/5 md:block">
      <span className="absolute -end-10 top-1/2 flex size-80 -translate-y-1/2 items-center justify-center">
        <svg
          viewBox="0 0 320 320"
          fill="none"
          className="absolute inset-0 size-full text-brand-solid/15 dark:text-brand-solid/30"
        >
          <circle
            cx="160"
            cy="160"
            r="152"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="14 16"
          />
          <circle
            cx="160"
            cy="160"
            r="92"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray="14 16"
          />
        </svg>
        <span className="flex size-18 items-center justify-center rounded-full bg-brand-solid/10 text-brand-solid dark:bg-brand-solid/20">
          {isSnippet ? <PanelRight size={28} /> : <NotebookPen size={28} />}
        </span>
      </span>

      {isSnippet ? (
        <>
          <span
            dir="auto"
            className="absolute start-16 top-7 flex flex-col gap-1 rounded-2xl border border-default/70 bg-surface-primary px-4 py-2.5 text-sm shadow-sm dark:bg-surface-secondary"
          >
            <span className="italic text-primary/50 dark:text-primary/65">
              “{t("dictionary.snippets.examples.signoffTrigger")}”
            </span>
            <span className="italic text-brand-solid">
              <span className="me-2 text-primary/50 dark:text-primary/65">↳</span>
              {t("dictionary.snippets.examples.signoffText")}
            </span>
          </span>
          <span
            dir="auto"
            className="absolute bottom-7 end-2 flex flex-col gap-1 rounded-2xl border border-default/70 bg-surface-primary px-4 py-2.5 text-sm shadow-sm dark:bg-surface-secondary"
          >
            <span className="italic text-primary/50 dark:text-primary/65">
              “{t("dictionary.snippets.examples.linkedinTrigger")}”
            </span>
            <span className="italic text-brand-solid">
              <span className="me-2 text-primary/50 dark:text-primary/65">↳</span>
              {t("dictionary.snippets.examples.linkedinText")}
            </span>
          </span>
        </>
      ) : (
        <>
          <span
            dir="ltr"
            className="absolute start-16 top-7 flex items-center gap-2 rounded-full border border-default/70 bg-surface-primary px-4 py-2.5 text-sm shadow-sm dark:bg-surface-secondary"
          >
            <span className="italic text-primary/50 line-through dark:text-primary/65">
              open whisper
            </span>
            <span className="font-medium text-brand-solid">OpenWhispr</span>
          </span>
          <span
            dir="ltr"
            className="absolute bottom-7 end-2 flex items-center gap-2 rounded-full border border-default/70 bg-surface-primary px-4 py-2.5 text-sm shadow-sm dark:bg-surface-secondary"
          >
            <span className="italic text-primary/50 line-through dark:text-primary/65">
              Cameren
            </span>
            <span className="font-medium text-brand-solid">Cameron</span>
          </span>
        </>
      )}
    </div>
  );
}
