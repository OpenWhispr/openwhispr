interface ChatEmptyIllustrationProps {
  size?: number;
}

export function ChatEmptyIllustration({ size = 56 }: ChatEmptyIllustrationProps) {
  const h = Math.round(size * (48 / 56));

  return (
    <svg
      className="text-foreground dark:text-white"
      width={size}
      height={h}
      viewBox="0 0 56 48"
      fill="none"
    >
      {/* Back bubble */}
      <rect
        x="16"
        y="18"
        width="36"
        height="24"
        rx="4"
        fill="currentColor"
        fillOpacity={0.03}
        stroke="currentColor"
        strokeOpacity={0.06}
      />
      <rect x="22" y="25" width="18" height="2" rx="1" fill="currentColor" fillOpacity={0.05} />
      <rect x="22" y="30" width="24" height="2" rx="1" fill="currentColor" fillOpacity={0.03} />

      {/* Front bubble */}
      <rect
        x="4"
        y="6"
        width="36"
        height="24"
        rx="4"
        fill="currentColor"
        fillOpacity={0.04}
        stroke="currentColor"
        strokeOpacity={0.08}
      />
      <rect x="10" y="13" width="18" height="2" rx="1" fill="currentColor" fillOpacity={0.06} />
      <rect x="10" y="18" width="24" height="2" rx="1" fill="currentColor" fillOpacity={0.04} />
      <rect x="10" y="23" width="14" height="2" rx="1" fill="currentColor" fillOpacity={0.03} />
    </svg>
  );
}
