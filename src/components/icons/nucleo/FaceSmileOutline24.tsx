import type { SVGProps } from "react";

export type FaceSmileOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function FaceSmileOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: FaceSmileOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M8.12602 14C8.57007 15.7252 10.1362 17 12 17C13.8638 17 15.4299 15.7252 15.874 14"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        data-color="color-2"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <circle
        cx="8.5"
        cy="9.5"
        r="1.5"
        fill="currentColor"
        data-color="color-2"
        data-cap="butt"
        data-stroke="none"
      ></circle>{" "}
      <circle
        cx="15.5"
        cy="9.5"
        r="1.5"
        fill="currentColor"
        data-color="color-2"
        data-cap="butt"
        data-stroke="none"
      ></circle>
    </svg>
  );
}
