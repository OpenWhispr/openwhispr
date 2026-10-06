import type { SVGProps } from "react";

export type CircleInfoOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function CircleInfoOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: CircleInfoOutline24Props) {
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
      <path
        d="m12,17v-5.5c0-.276-.224-.5-.5-.5h-1.5"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
      <circle
        cx="12"
        cy="7.25"
        r="1.25"
        fill="currentColor"
        strokeWidth={0}
        data-color="color-2"
        data-cap="butt"
      ></circle>
    </svg>
  );
}
