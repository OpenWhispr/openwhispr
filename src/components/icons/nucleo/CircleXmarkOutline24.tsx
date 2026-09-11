import type { SVGProps } from "react";

export type CircleXmarkOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function CircleXmarkOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: CircleXmarkOutline24Props) {
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
        x1="15.5"
        y1="8.5"
        x2="8.5"
        y2="15.5"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></line>
      <line
        x1="15.5"
        y1="15.5"
        x2="8.5"
        y2="8.5"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></line>
    </svg>
  );
}
