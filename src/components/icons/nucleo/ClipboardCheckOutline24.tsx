import type { SVGProps } from "react";

export type ClipboardCheckOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function ClipboardCheckOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: ClipboardCheckOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M8 3L6 3C4.89543 3 4 3.89543 4 5L4 20C4 21.1046 4.89543 22 6 22L8 22M16 3L18 3C19.1046 3 20 3.89543 20 5L20 9"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M15 23L21.5 16.5C22.3284 15.6716 22.3284 14.3284 21.5 13.5C20.6716 12.6716 19.3284 12.6716 18.5 13.5L12 20V23H15Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M8.5 11L11 13.5L15.5 9"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M8 5V2C8 1.44772 8.44772 1 9 1H15C15.5523 1 16 1.44772 16 2V5H8Z"
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
