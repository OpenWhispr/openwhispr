import type { SVGProps } from "react";

export type MessageOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function MessageOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: MessageOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="m20,3H4c-1.105,0-2,.895-2,2v10c0,1.105.895,2,2,2h2v5l7-5h7c1.105,0,2-.895,2-2V5c0-1.105-.895-2-2-2Z"
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
