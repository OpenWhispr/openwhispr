import type { SVGProps } from "react";

export type GlobeOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function GlobeOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: GlobeOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="M22 12H2"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        data-cap="butt"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M12 22V22C17.7143 16.5578 17.7143 7.44218 12 2V2"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        data-cap="butt"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M12 22V22C6.28571 16.5578 6.28571 7.44218 12 2V2"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        data-color="color-2"
        fill="none"
        data-cap="butt"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>{" "}
      <path
        d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22Z"
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
