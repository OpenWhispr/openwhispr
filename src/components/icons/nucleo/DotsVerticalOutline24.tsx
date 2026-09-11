import type { SVGProps } from "react";

export type DotsVerticalOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function DotsVerticalOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: DotsVerticalOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <circle
        cx="12"
        cy="12"
        r=".75"
        fill="currentColor"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></circle>
      <circle
        cx="12"
        cy="3.75"
        r=".75"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        fill="currentColor"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></circle>
      <circle
        cx="12"
        cy="20.25"
        r=".75"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        fill="currentColor"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></circle>
    </svg>
  );
}
