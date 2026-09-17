import type { SVGProps } from "react";

export type GridOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function GridOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: GridOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <rect
        x="3"
        y="3"
        width={7}
        height={7}
        rx="1"
        ry="1"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></rect>
      <rect
        x="3"
        y="14"
        width={7}
        height={7}
        rx="1"
        ry="1"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></rect>
      <rect
        x="14"
        y="3"
        width={7}
        height={7}
        rx="1"
        ry="1"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></rect>
      <rect
        x="14"
        y="14"
        width={7}
        height={7}
        rx="1"
        ry="1"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></rect>
    </svg>
  );
}
