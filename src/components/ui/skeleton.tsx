import { cn } from "../lib/utils";

// A span, so it can sit inside a <p>; add inline-block to keep that line's height.
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("block animate-pulse rounded-md bg-foreground/6", className)} {...props} />
  );
}

export { Skeleton };
