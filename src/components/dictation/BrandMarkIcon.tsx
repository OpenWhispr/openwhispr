import React from "react";

interface BrandMarkIconProps {
  size?: number;
  className?: string;
}

/**
 * Circled sound-bars brand mark. Draws in `currentColor` so it follows the
 * neutral foreground treatment of the surface that contains it.
 */
export function BrandMarkIcon({ size = 24, className }: BrandMarkIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
      <rect x="7.75" y="9.5" width="2" height="5" rx="1" fill="currentColor" />
      <rect x="11" y="7" width="2" height="10" rx="1" fill="currentColor" />
      <rect x="14.25" y="9.5" width="2" height="5" rx="1" fill="currentColor" />
    </svg>
  );
}
