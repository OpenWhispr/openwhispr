import type { SVGProps } from "react";

export type Upload4Outline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function Upload4Outline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: Upload4Outline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="m3,16v3c0,1.105.895,2,2,2h14c1.105,0,2-.895,2-2v-3"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
      <polyline
        points="12 15 12 3 12 4"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></polyline>
      <polyline
        points="17 8 12 3 7 8"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></polyline>
    </svg>
  );
}
