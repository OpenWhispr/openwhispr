import { cn } from "../lib/utils";

interface LogoTileProps {
  src: string;
  alt: string;
  monochrome?: boolean;
  className?: string;
}

export function LogoTile({ src, alt, monochrome, className }: LogoTileProps) {
  return (
    <div
      className={cn(
        "w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/10 flex items-center justify-center shrink-0",
        className
      )}
    >
      <img
        src={src}
        alt={alt}
        aria-hidden={alt ? undefined : true}
        width={20}
        height={20}
        decoding="async"
        draggable={false}
        className={`w-5 h-5${monochrome ? " icon-monochrome" : ""}`}
      />
    </div>
  );
}
