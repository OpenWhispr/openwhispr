import type { TextStyle, ViewStyle } from 'react-native';
import { glassEdge, home, TILE_FILL, type } from '../home/kit';

/**
 * Settings in OpenWhispr's design language (Figma "Settings · Fable reskin", the look of Fable's
 * Processing section 8): the desktop's glass edge on cards, fields and white buttons, grey icon
 * tiles, square badges. Processing's `processingFable/look.tsx` builds on these.
 */
export const look = {
  canvas: '#F2F1EF',
  selFill: 'rgba(21,75,212,0.12)',
  idleFill: TILE_FILL,
  track: '#E8E7E4',
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
