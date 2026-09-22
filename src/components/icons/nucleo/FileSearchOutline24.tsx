import type { SVGProps } from "react";

export type FileSearchOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function FileSearchOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: FileSearchOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M20 11.5V4C20 2.89543 19.1046 2 18 2H11.0784C10.548 2 10.0393 2.21071 9.66421 2.58579L4.58579 7.66421C4.21071 8.03929 4 8.54799 4 9.07843L4 20C4 21.1046 4.89543 22 6 22H9.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M4 9H11V2"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M15.5 21C17.433 21 19 19.433 19 17.5C19 15.567 17.433 14 15.5 14C13.567 14 12 15.567 12 17.5C12 19.433 13.567 21 15.5 21Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M20.5 22.5L17.975 19.975"
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
