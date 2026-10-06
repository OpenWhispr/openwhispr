import type { SVGProps } from "react";

export type Cloud2Outline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function Cloud2Outline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: Cloud2Outline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="m19,19c2.2,0,4-1.8,4-4s-1.8-4-4-4h0c-.3-3.9-3.5-7-7.5-7s-7.3,3.2-7.5,7.1c-1.7.4-3,2-3,3.9,0,2.2,1.8,4,4,4h14Z"
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
