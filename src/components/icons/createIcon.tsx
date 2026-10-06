import type { ComponentType, FunctionComponent, SVGProps } from "react";

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
  corners?: "round" | "square";
};

export type IconComponent = FunctionComponent<IconProps>;

// Adapts a vendored Nucleo component to the prop surface the app already uses
// (`size`, `strokeWidth`, `className`, …). `data-icon` carries the app-facing
// name so markup stays identifiable in tests and dev tools.
export function createIcon(name: string, Nucleo: ComponentType<IconProps>): IconComponent {
  const Icon: IconComponent = ({ size, ...props }) => (
    <Nucleo
      {...(size !== undefined && { width: size, height: size })}
      data-icon={name}
      aria-hidden={props["aria-label"] ? undefined : true}
      {...props}
    />
  );
  Icon.displayName = name;
  return Icon;
}
