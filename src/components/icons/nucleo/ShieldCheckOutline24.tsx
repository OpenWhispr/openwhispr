import type { SVGProps } from "react";

export type ShieldCheckOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function ShieldCheckOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: ShieldCheckOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <polyline
        points="8 12.75 10.25 15 16 8.75"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></polyline>
      <path
        d="m12,22s9-2,9-11v-7c-3.203,0-6.11-.731-9-2-2.89,1.269-5.797,2-9,2v7c0,9,9,11,9,11Z"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
