import type { SVGProps } from "react";

export type PenOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function PenOutline24({ strokeWidth = 2, corners = "round", ...props }: PenOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M9,20l-7,2,2-7L16.414,2.586c.781-.781,2.047-.781,2.828,0l2.172,2.172c.781,.781,.781,2.047,0,2.828l-12.414,12.414Z"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
