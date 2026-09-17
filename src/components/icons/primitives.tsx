import type { SVGProps } from "react";
import { createIcon } from "./createIcon";

type MarkProps = SVGProps<SVGSVGElement> & { strokeWidth?: number | string };

// Plain geometric marks used as status dots and stop indicators. Nucleo has no
// bare circle or square, and these are simpler drawn by hand than mapped.
function CircleMark({ strokeWidth = 2, ...props }: MarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      {...props}
    >
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

function SquareMark({ strokeWidth = 2, ...props }: MarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}

export const Circle = createIcon("circle", CircleMark);
export const Square = createIcon("square", SquareMark);
