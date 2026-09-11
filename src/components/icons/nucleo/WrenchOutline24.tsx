import type { SVGProps } from "react";

export type WrenchOutline24Props = SVGProps<SVGSVGElement> & {
  strokeWidth?: number | string;
  corners?: "round" | "square";
};

export function WrenchOutline24({
  strokeWidth = 2,
  corners = "round",
  ...props
}: WrenchOutline24Props) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} viewBox="0 0 24 24" {...props}>
      <path
        d="m11.373,9.479l-8.437,7.593c-1.204,1.083-1.253,2.955-.108,4.1,1.156,1.156,3.049,1.093,4.126-.136l7.413-8.465"
        fill="none"
        stroke="currentColor"
        strokeMiterlimit="10"
        strokeWidth={strokeWidth}
        data-color="color-2"
        data-cap="butt"
        strokeLinejoin={corners === "round" ? "round" : "miter"}
        strokeLinecap={corners === "round" ? "round" : "butt"}
      ></path>
      <path
        d="m18.164,8.664l-2.828-2.828,3.372-3.372c-.676-.297-1.422-.464-2.207-.464-3.038,0-5.5,2.462-5.5,5.5s2.462,5.5,5.5,5.5,5.5-2.462,5.5-5.5c0-.786-.167-1.531-.464-2.207l-3.372,3.372Z"
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
