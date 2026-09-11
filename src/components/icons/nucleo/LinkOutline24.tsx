import type { SVGProps } from "react";

export type LinkOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function LinkOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: LinkOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="m19.014,11.943l1.021,1.021c1.953,1.953,1.953,5.118,0,7.071h0c-1.953,1.953-5.118,1.953-7.071,0l-3.121-3.121c-1.953-1.953-1.953-5.118,0-7.071h0c.366-.366.775-.664,1.21-.892"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
      <path
        d="m12.934,15.056c.44-.23.853-.529,1.223-.899h0c1.953-1.953,1.953-5.118,0-7.071l-3.121-3.121c-1.953-1.953-5.118-1.953-7.071,0h0c-1.953,1.953-1.953,5.118,0,7.071l1.021,1.021"
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
