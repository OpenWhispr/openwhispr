import type { SVGProps } from "react";

export type CircleWarningOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function CircleWarningOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: CircleWarningOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <circle
        cx="12"
        cy="12"
        r="10"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></circle>
      <line
        x1="12"
        y1="7"
        x2="12"
        y2="13"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></line>
      <circle
        cx="12"
        cy="16.75"
        r="1.25"
        fill="currentColor"
        strokeWidth={0}
        data-color="color-2"
        data-cap="butt"
      ></circle>
    </svg>
  );
}
