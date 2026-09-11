import type { SVGProps } from "react";

export type ChevronUpOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function ChevronUpOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: ChevronUpOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M21 16L12 7L3 16"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
