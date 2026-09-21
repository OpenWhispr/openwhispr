import type { SVGProps } from "react";

export type GearOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function GearOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: GearOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <circle
        cx="12"
        cy="12"
        r="3"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></circle>
      <path
        d="m22,12h0c0-.757-.455-1.44-1.154-1.731l-1.164-.485c-.099-.343-.219-.678-.36-1.001-.198-.453-.192-.969-.004-1.426l.16-.389c.288-.7.127-1.504-.408-2.04h0c-.535-.535-1.34-.696-2.04-.408l-1.162.479c-.518-.287-1.073-.515-1.654-.682l-.485-1.164c-.291-.699-.974-1.154-1.731-1.154h0c-.757,0-1.44.455-1.731,1.154l-.485,1.164c-.581.167-1.135.395-1.654.682l-1.162-.479c-.7-.288-1.504-.127-2.04.408h0c-.535.535-.696,1.34-.408,2.04l.479,1.162c-.287.518-.515,1.073-.682,1.654l-1.164.485c-.699.291-1.154.974-1.154,1.731h0c0,.757.455,1.44,1.154,1.731l1.164.485c.167.581.395,1.135.682,1.654l-.479,1.162c-.288.7-.127,1.504.408,2.04h0c.535.535,1.34.696,2.04.408l1.162-.479c.518.287,1.073.515,1.654.682l.485,1.164c.291.699.974,1.154,1.731,1.154h0c.757,0,1.44-.455,1.731-1.154l.485-1.164c.581-.167,1.135-.395,1.654-.682l1.162.479c.7.288,1.504.127,2.04-.408h0c.535-.535.696-1.34.408-2.04l-.479-1.162c.287-.518.515-1.073.682-1.654l1.164-.485c.699-.291,1.154-.974,1.154-1.731Z"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "square"}
      ></path>
    </svg>
  );
}
