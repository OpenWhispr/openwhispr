import Svg, { Circle, Line } from 'react-native-svg';

/**
 * The OpenWhispr brand mark — a ringed waveform (tall center bar flanked by two
 * short bars), drawn as strokes with a transparent background so it sits cleanly
 * on any surface. Reconstructed from the design SVG; no blue app-icon tile.
 */
export function OpenWhisprMark({
  size = 32,
  color = '#FFFFFF',
}: {
  size?: number;
  color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 41.23 41.23">
      <Circle cx={20.617} cy={20.617} r={18.889} fill="none" stroke={color} strokeWidth={3.456} />
      <Line
        x1={13.86}
        y1={17.39}
        x2={13.86}
        y2={23.91}
        stroke={color}
        strokeWidth={4.246}
        strokeLinecap="round"
      />
      <Line
        x1={20.61}
        y1={13.04}
        x2={20.61}
        y2={28.19}
        stroke={color}
        strokeWidth={4.246}
        strokeLinecap="round"
      />
      <Line
        x1={27.37}
        y1={17.39}
        x2={27.37}
        y2={23.91}
        stroke={color}
        strokeWidth={4.246}
        strokeLinecap="round"
      />
    </Svg>
  );
}
