import type { SVGProps } from "react";

export type ArrowUpOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function ArrowUpOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: ArrowUpOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M12 21V3V3.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M19 10L12 3L5 10"
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
