import type { SVGProps } from "react";

export type TestTubeOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function TestTubeOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: TestTubeOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M8 15H11"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M8 10H11"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M8 18V6L6.00003 5.5V2H18V5.5L16 6V18C16 20.2091 14.2091 22 12 22C9.79086 22 8 20.2091 8 18Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
