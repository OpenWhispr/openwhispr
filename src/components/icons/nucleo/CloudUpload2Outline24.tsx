import type { SVGProps } from "react";

export type CloudUpload2Outline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function CloudUpload2Outline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: CloudUpload2Outline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M11.9999 21L11.9999 10L12 10.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M16.2427 14.2428L12 10.0001L7.75739 14.2428"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M7 19H5C2.8 19 1 17.2 1 15C1 13.1 2.3 11.5 4 11.1C4.2 7.2 7.5 4 11.5 4C15.5 4 18.7 7.1 19 11C21.2 11 23 12.8 23 15C23 17.2 21.2 19 19 19H17"
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
