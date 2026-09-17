import type { SVGProps } from "react";

export type BrainOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function BrainOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: BrainOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M3.40118 12.0466L3.5 12C2.61705 12.3858 2 13.4748 2 14.5C2 15.7536 2.9227 16.7917 4.12602 16.9722C3.50585 22.4483 10.8507 23.6333 11.97 19.129L12 16"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M20.5988 12.0466L20.5 12C21.383 12.3858 22 13.4748 22 14.5C22 15.7536 21.0773 16.7917 19.874 16.9722C20.4941 22.4483 13.1493 23.6333 12.03 19.129L12 16"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M7 13H6C3.79086 13 2.5 11.2091 2.5 9C2.5 6.5 4.51867 5 7 5C7 3.48283 7.7632 2 9.5 2C10.6755 2 11.7302 2.9068 12 4V7C12 8.10457 11.1046 9 10 9V9"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M14 9V9C12.8959 9.00159 12 8.10698 12 7.00287V4C12.2698 2.9068 13.3245 2 14.5 2C16.2368 2 17 3.48283 17 5C19.4813 5 21.5 6.5 21.5 9C21.5 11.2091 20.2091 13 18 13H17"
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
