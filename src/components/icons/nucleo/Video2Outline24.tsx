import type { SVGProps } from "react";

export type Video2Outline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function Video2Outline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: Video2Outline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M16 5H4C2.89543 5 2 5.89543 2 7V17C2 18.1046 2.89543 19 4 19H16C17.1046 19 18 18.1046 18 17V15.5L22 17V7L18 8.5V7C18 5.89543 17.1046 5 16 5Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M6.25 10.5C6.94036 10.5 7.5 9.94036 7.5 9.25C7.5 8.55964 6.94036 8 6.25 8C5.55964 8 5 8.55964 5 9.25C5 9.94036 5.55964 10.5 6.25 10.5Z"
        fill="currentColor"
        data-color="color-2"
        data-cap="butt"
        data-stroke="none"
      ></path>
    </svg>
  );
}
