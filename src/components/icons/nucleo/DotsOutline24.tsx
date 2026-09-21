import type { SVGProps } from "react";

export type DotsOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function DotsOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: DotsOutline24Props) {
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
        cx="20.25"
        cy="12"
        r=".75"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        fill="currentColor"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></circle>
      <circle
        cx="3.75"
        cy="12"
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
