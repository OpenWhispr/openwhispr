import type { SVGProps } from "react";

export type LaptopOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function LaptopOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: LaptopOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M3 13V5C3 3.89543 3.89543 3 5 3H19C20.1046 3 21 3.89543 21 5V13"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M1 17V19C1 20.1046 1.89543 21 3 21H21C22.1046 21 23 20.1046 23 19V17H16C16 17.5523 15.5523 18 15 18H9C8.44772 18 8 17.5523 8 17H1Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
