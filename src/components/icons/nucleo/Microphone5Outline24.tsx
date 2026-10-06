import type { SVGProps } from "react";

export type Microphone5Outline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function Microphone5Outline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: Microphone5Outline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M14.1924 14.0502L6.41421 20.4142L5.00001 19L3.5858 17.5858L9.94976 9.8076"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M2.99999 22L2.5 21.5L1.99997 21"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M11.5 12.5C13.8432 14.8431 17.6421 14.8431 19.9853 12.5C22.3284 10.1569 22.3284 6.35786 19.9853 4.01472C17.6421 1.67157 13.8432 1.67157 11.5 4.01472C9.15686 6.35786 9.15686 10.1569 11.5 12.5Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
