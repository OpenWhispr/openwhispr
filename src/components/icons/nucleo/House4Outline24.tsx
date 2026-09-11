import type { SVGProps } from "react";

export type House4Outline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function House4Outline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: House4Outline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <polygon
        points="12 2 3 10 3 21 10 21 10 15 14 15 14 21 21 21 21 10 12 2"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></polygon>
    </svg>
  );
}
