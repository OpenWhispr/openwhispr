import type { SVGProps } from "react";

export type Copy2Outline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function Copy2Outline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: Copy2Outline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M10.5 8H19.5C20.3284 8 21 8.67157 21 9.5V20.5C21 21.3284 20.3284 22 19.5 22H10.5C9.67157 22 9 21.3284 9 20.5V9.5C9 8.67157 9.67157 8 10.5 8Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M15 4V3.5C15 2.67157 14.3284 2 13.5 2L4.5 2C3.67157 2 3 2.67157 3 3.5L3 14.5C3 15.3284 3.67157 16 4.5 16H5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
