import type { SVGProps } from "react";

export type Redo2Outline18Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
};

export function Redo2Outline18({ strokeWidth = 1.5, ...props }: Redo2Outline18Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={18} height={18} viewBox="0 0 18 18" {...props}>
      <path
        d="m15.0002,12.0949c-1.1221,2.171-3.3878,3.6551-6.0002,3.6551-3.728,0-6.75-3.0221-6.75-6.75s3.022-6.75,6.75-6.75c1.864,0,3.5515.7555,4.773,1.977"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        data-color="color-2"
      ></path>
      <polygon
        points="11.614 5.6341 15.5736 6.2422 15.0759 2.4461 11.614 5.6341"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={strokeWidth}
        fill="currentColor"
      ></polygon>
    </svg>
  );
}
