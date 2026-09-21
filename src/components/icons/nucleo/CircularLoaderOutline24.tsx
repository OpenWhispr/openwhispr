import type { SVGProps } from "react";

export type CircularLoaderOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function CircularLoaderOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: CircularLoaderOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        opacity={0.4}
        d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M22 12C22 6.47715 17.5228 2 12 2"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>
    </svg>
  );
}
