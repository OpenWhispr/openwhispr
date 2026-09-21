import type { SVGProps } from "react";

export type FloppyDiskOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function FloppyDiskOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: FloppyDiskOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <polyline
        points="7 17 7 13 17 13 17 17"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></polyline>
      <path
        d="m19,21H5c-1.105,0-2-.895-2-2V5c0-1.105.895-2,2-2h11l5,5v11c0,1.105-.895,2-2,2Z"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
      <line
        x1="15"
        y1="7"
        x2="15"
        y2="9"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></line>
    </svg>
  );
}
