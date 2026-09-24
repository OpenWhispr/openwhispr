import Svg, { Path } from 'react-native-svg';

/**
 * Inline SVG cloud / cloud-off glyph for the Home mode toggle.
 *
 * Rendered with react-native-svg (synchronous) rather than `SystemIcon`, whose
 * iOS path loads SF Symbols through expo-image asynchronously — that left the
 * toggle icon blank on first mount until a re-render. SVG paints immediately.
 */
export function CloudIcon({
  size = 16,
  color = '#FFFFFF',
  off = false,
}: {
  size?: number;
  color?: string;
  off?: boolean;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M7 18a4 4 0 0 1 .6-7.96 5 5 0 0 1 9.65 1.06A3.5 3.5 0 0 1 17 18z"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {off ? (
        <Path
          d="M3 3l18 18"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </Svg>
  );
}
