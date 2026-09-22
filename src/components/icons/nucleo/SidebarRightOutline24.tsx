import type { SVGProps } from "react";

export type SidebarRightOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function SidebarRightOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: SidebarRightOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <line
        x1="15"
        y1="4"
        x2="15"
        y2="20"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        data-cap="butt"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></line>
      <rect
        x="4"
        y="2"
        width={16}
        height={20}
        rx="2"
        ry="2"
        transform="translate(24) rotate(90)"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></rect>
    </svg>
  );
}
