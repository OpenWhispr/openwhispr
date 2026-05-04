interface LogoTileProps {
  src: string;
  alt: string;
  monochrome?: boolean;
}

export function LogoTile({ src, alt, monochrome }: LogoTileProps) {
  return (
    <div className="w-9 h-9 rounded-lg bg-white dark:bg-surface-raised shadow-[0_0_0_1px_rgba(0,0,0,0.04)] dark:shadow-none dark:border dark:border-white/5 flex items-center justify-center shrink-0">
      <img src={src} alt={alt} className={`w-5 h-5${monochrome ? " icon-monochrome" : ""}`} />
    </div>
  );
}
