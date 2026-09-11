import type { SVGProps } from "react";

export type FireFlameOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function FireFlameOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: FireFlameOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="m12,22c1.067,0,4-.786,4-3.929,0-2.655-1.542-4.321-4-7.071-2.458,2.75-4,4.417-4,7.071,0,3.143,2.933,3.929,4,3.929Z"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
      <path
        d="m4,14C4,8.516,12,1.375,12,1.375c0,0,8,7.125,8,12.625,0,5.1-4.1,8-8,8s-8-2.9-8-8Z"
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
