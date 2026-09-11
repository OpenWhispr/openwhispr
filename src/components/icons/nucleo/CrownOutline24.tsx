import type { SVGProps } from "react";

export type CrownOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function CrownOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: CrownOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M2.5 15H21.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M17 9.78125L22 6.1875L21.144 17.1556C21.0627 18.1967 20.1942 19 19.15 19H4.84998C3.80577 19 2.9373 18.1967 2.85605 17.1556L2 6.1875L7 9.78125L12 3L17 9.78125Z"
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
