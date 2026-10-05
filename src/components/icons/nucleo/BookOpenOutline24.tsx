import type { SVGProps } from "react";

export type BookOpenOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function BookOpenOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: BookOpenOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <line
        x1="12"
        y1="6"
        x2="12"
        y2="21"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        data-cap="butt"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></line>
      <path
        d="m17.5,3c-3,0-5.5,1.3-5.5,3,0-1.7-2.5-3-5.5-3S1,4.3,1,6v15c0-1.7,2.5-3,5.5-3s5.5,1.3,5.5,3c0-1.7,2.5-3,5.5-3s5.5,1.3,5.5,3V6c0-1.7-2.5-3-5.5-3Z"
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
