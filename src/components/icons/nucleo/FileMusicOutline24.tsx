import type { SVGProps } from "react";

export type FileMusicOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function FileMusicOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: FileMusicOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M20 10V4C20 2.89543 19.1046 2 18 2H11.0784C10.548 2 10.0393 2.21071 9.66421 2.58579L4.58579 7.66421C4.21071 8.03929 4 8.54799 4 9.07843L4 20C4 21.1046 4.89543 22 6 22H9"
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
        d="M21 15V15C20.0044 14.6681 19.0576 14.205 18.1844 13.6229L18 13.5V20.5V20"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M15.5 23C16.8807 23 18 21.8807 18 20.5C18 19.1193 16.8807 18 15.5 18C14.1193 18 13 19.1193 13 20.5C13 21.8807 14.1193 23 15.5 23Z"
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
