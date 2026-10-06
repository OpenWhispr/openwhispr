import type { SVGProps } from "react";

export type SparkleOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function SparkleOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: SparkleOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M17.85 15.15L16.5 12L15.15 15.15L12 16.5L15.15 17.85L16.5 21L17.85 17.85L21 16.5L17.85 15.15Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M8.85 6.15L7.5 3L6.15 6.15L3 7.5L6.15 8.85L7.5 12L8.85 8.85L12 7.5L8.85 6.15Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M20.2 3.8L19 1L17.8 3.8L15 5L17.8 6.2L19 9L20.2 6.2L23 5L20.2 3.8Z"
        fill="currentColor"
        data-color="color-2"
        data-cap="butt"
        data-stroke="none"
      ></path>{" "}
      <path
        d="M6.2 17.8L5 15L3.8 17.8L1 19L3.8 20.2L5 23L6.2 20.2L9 19L6.2 17.8Z"
        fill="currentColor"
        data-color="color-2"
        data-cap="butt"
        data-stroke="none"
      ></path>
    </svg>
  );
}
