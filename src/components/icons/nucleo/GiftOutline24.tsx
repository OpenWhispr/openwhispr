import type { SVGProps } from "react";

export type GiftOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function GiftOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: GiftOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <line
        x1="12"
        y1="7.001"
        x2="12"
        y2="21"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></line>
      <path
        d="m4,4.501c.047-1.426,1.241-2.545,2.667-2.5,3.944,0,5.333,5,5.333,5h-5.333c-1.426.045-2.62-1.074-2.667-2.5Z"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
      <path
        d="m17.333,7.001h-5.333s1.389-5,5.333-5c1.426-.045,2.62,1.074,2.667,2.5-.047,1.426-1.241,2.545-2.667,2.5Z"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
      <path
        d="m20,11v8c0,1.105-.895,2-2,2H6c-1.105,0-2-.895-2-2v-8"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
      <line
        x1="2"
        y1="7.001"
        x2="22"
        y2="7.001"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></line>
    </svg>
  );
}
