import { cn } from "../lib/utils";

export const notesInputClass = cn(
  "w-full h-8 px-3 rounded-md text-xs",
  "bg-foreground/3 dark:bg-white/4 border border-border/30 dark:border-white/6",
  "text-foreground/80 placeholder:text-foreground/20 outline-none",
  "focus:border-primary/30 transition-colors duration-150"
);
