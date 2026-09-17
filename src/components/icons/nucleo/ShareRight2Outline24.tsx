import type { SVGProps } from "react";

export type ShareRight2Outline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function ShareRight2Outline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: ShareRight2Outline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="m19,17v2c0,1.105-.895,2-2,2H4c-1.105,0-2-.895-2-2V6c0-1.105.895-2,2-2h3"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
      <path
        d="m22.5,9l-7.5-6v3c-4.894,0-9,2.057-9,9,1.788-2.143,4.012-3,9-3v3s7.5-6,7.5-6Z"
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
