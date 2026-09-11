import type { SVGProps } from "react";

export type TrophyOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function TrophyOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: TrophyOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M18 3H22V6C22 7.65685 20.6569 9 19 9H18"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M6 3H2V6C2 7.65685 3.34315 9 5 9H6"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M12 14V18"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M6 3V8C6 11.3137 8.68629 14 12 14C15.3137 14 18 11.3137 18 8V3H6Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M16 22H8V21C8 19.3431 9.34315 18 11 18H13C14.6569 18 16 19.3431 16 21V22Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
