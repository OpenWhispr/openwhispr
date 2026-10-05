import type { SVGProps } from "react";

export type WandSparkleOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function WandSparkleOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: WandSparkleOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M1.73999 18.7279L5.2755 22.2635L18.0034 9.53553L14.4679 6L1.73999 18.7279Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeMiterlimit="10"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>{" "}
      <path
        d="M10.5 10L14 13.5"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-cap="butt"
        fill="none"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M21.1 2.9L20.05 0.45L19 2.9L16.55 3.95L19 5L20.05 7.45L21.1 5L23.55 3.95L21.1 2.9Z"
        fill="currentColor"
        data-color="color-2"
        data-cap="butt"
        data-stroke="none"
      ></path>{" "}
      <path
        d="M21.1 14L20.05 11.55L19 14L16.55 15.05L19 16.1L20.05 18.55L21.1 16.1L23.55 15.05L21.1 14Z"
        fill="currentColor"
        data-color="color-2"
        data-cap="butt"
        data-stroke="none"
      ></path>{" "}
      <path
        d="M10 2.9L8.95 0.450001L7.9 2.9L5.45 3.95L7.9 5L8.95 7.45L10 5L12.45 3.95L10 2.9Z"
        fill="currentColor"
        data-color="color-2"
        data-cap="butt"
        data-stroke="none"
      ></path>
    </svg>
  );
}
