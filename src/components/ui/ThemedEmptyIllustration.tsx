import { cn } from "../lib/utils";

interface ThemedEmptyIllustrationProps {
  light: string;
  dark: string;
  width: number;
  height: number;
  className?: string;
}

export default function ThemedEmptyIllustration({
  light,
  dark,
  width,
  height,
  className,
}: ThemedEmptyIllustrationProps) {
  return (
    <span className={cn("inline-block max-w-full", className)} aria-hidden="true">
      <img
        src={light}
        width={width}
        height={height}
        alt=""
        className="block h-auto max-w-full dark:hidden"
      />
      <img
        src={dark}
        width={width}
        height={height}
        alt=""
        className="hidden h-auto max-w-full dark:block"
      />
    </span>
  );
}
