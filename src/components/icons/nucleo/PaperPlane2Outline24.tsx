import type { SVGProps } from "react";

export type PaperPlane2Outline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function PaperPlane2Outline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: PaperPlane2Outline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <line
        x1="20.5"
        y1="3.5"
        x2="9.5"
        y2="14.5"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        data-cap="butt"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></line>
      <polygon
        points="20.5 3.5 14.5 21.5 9.5 14.5 2.5 9.5 20.5 3.5"
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
