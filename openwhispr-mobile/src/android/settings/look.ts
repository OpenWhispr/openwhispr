import type { TextStyle, ViewStyle } from 'react-native';
import { glassEdge, home, type } from '../home/kit';
import { theme } from '../theme';

/**
 * Settings in OpenWhispr's glossy white design language (`../theme`): flat cards and fields,
 * raised white buttons, grey icon tiles, square badges. Processing's `processingFable/look.tsx` builds on these.
 */
export const look = {
  canvas: theme.canvas,
  selFill: theme.selFill,
  idleFill: theme.tile,
  track: theme.track,
  error: '#D70015',
  hairline: glassEdge.borderColor,
  fieldHairline: 'rgba(0,0,0,0.10)',
  edgeShadow: glassEdge.boxShadow,
};

/** The glass edge: a hairline, an inner top highlight and a soft lift, on white. */
export const edge: ViewStyle = glassEdge;

/** White card with the glass edge. */
export const edgeCard: ViewStyle = { ...edge, borderRadius: 16, overflow: 'hidden' };

/** A text field: corners 12 and a slightly darker hairline. */
export const edgeField: ViewStyle = { ...edge, borderRadius: 12, borderColor: look.fieldHairline };

export const sectionLabel: TextStyle = type.section;

/** Body copy on the canvas (an intro above a card). */
export const bodyText: TextStyle = { fontSize: 16, lineHeight: 21, color: home.text };
