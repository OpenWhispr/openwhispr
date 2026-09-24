import { NotebookPen, PanelRight } from "./icons";

interface DictionaryEmptyIllustrationProps {
  variant: "dictionary" | "snippets";
}

export default function DictionaryEmptyIllustration({ variant }: DictionaryEmptyIllustrationProps) {
  const isSnippet = variant === "snippets";

  return (
    <div aria-hidden="true" className="absolute inset-y-0 end-0 hidden w-2/5 md:block">
      <span className="absolute -right-10 top-1/2 flex size-80 -translate-y-1/2 items-center justify-center">
        <svg
          viewBox="0 0 320 320"
          fill="none"
          className="absolute inset-0 size-full text-primary/15 dark:text-primary/30"
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
        <span className="flex size-18 items-center justify-center rounded-full bg-primary/10 text-primary dark:bg-primary/20">
          {isSnippet ? <PanelRight size={28} /> : <NotebookPen size={28} />}
        </span>
      </span>

      {isSnippet ? (
        <>
          <span
            dir="ltr"
            className="absolute left-16 top-7 flex flex-col gap-1 rounded-2xl border border-border/70 bg-card px-4 py-2.5 text-sm shadow-sm dark:bg-surface-window"
          >
            <span className="italic text-foreground/50 dark:text-foreground/65">“brb”</span>
            <span className="italic text-primary">
              <span className="mr-2 text-foreground/50 dark:text-foreground/65">↳</span>be right
              back
            </span>
          </span>
          <span
            dir="ltr"
            className="absolute bottom-7 right-2 flex flex-col gap-1 rounded-2xl border border-border/70 bg-card px-4 py-2.5 text-sm shadow-sm dark:bg-surface-window"
          >
            <span className="italic text-foreground/50 dark:text-foreground/65">“my linkedin”</span>
            <span className="italic text-primary">
              <span className="mr-2 text-foreground/50 dark:text-foreground/65">↳</span>
              www.linkedin.com/in/your-profile
            </span>
          </span>
        </>
      ) : (
        <>
          <span
            dir="ltr"
            className="absolute left-16 top-7 flex items-center gap-2 rounded-full border border-border/70 bg-card px-4 py-2.5 text-sm shadow-sm dark:bg-surface-window"
          >
            <span className="italic text-foreground/50 line-through dark:text-foreground/65">
              open whisper
            </span>
            <span className="font-medium text-primary">OpenWhispr</span>
          </span>
          <span
            dir="ltr"
            className="absolute bottom-7 right-2 flex items-center gap-2 rounded-full border border-border/70 bg-card px-4 py-2.5 text-sm shadow-sm dark:bg-surface-window"
          >
            <span className="italic text-foreground/50 line-through dark:text-foreground/65">
              Cameren
            </span>
            <span className="font-medium text-primary">Cameron</span>
          </span>
        </>
      )}
    </div>
  );
}
