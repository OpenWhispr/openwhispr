import type { SVGProps } from "react";

export type CircleQuestionOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function CircleQuestionOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: CircleQuestionOutline24Props) {
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
      <circle
        cx="12"
        cy="17.25"
        r="1.25"
        fill="currentColor"
        strokeWidth={0}
        data-color="color-2"
        data-cap="butt"
      ></circle>
      <path
        d="m9.244,8.369c.422-1.608,1.733-2.44,3.201-2.364,1.45.075,2.799.872,2.737,2.722-.089,2.63-2.884,2.273-3.197,4.773h.011"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
