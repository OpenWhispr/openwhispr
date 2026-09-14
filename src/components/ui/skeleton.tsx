import { cn } from "../lib/utils";

// A span, so a skeleton can stand in for text inside a <p> or heading and keep its line height.
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("block animate-pulse rounded-md bg-foreground/6", className)} {...props} />
  );
}

export { Skeleton };
