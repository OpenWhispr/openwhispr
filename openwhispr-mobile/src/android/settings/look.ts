import type { TextStyle, ViewStyle } from 'react-native';
import { home } from '../home/kit';

/**
 * Settings in OpenWhispr's design language (Figma "Settings · Fable reskin", the look of Fable's
 * Processing section 8): the desktop's glass edge on cards, fields and white buttons, grey icon
 * tiles, square badges. Processing's `processingFable/look.tsx` builds on these.
 */
export const look = {
  canvas: '#F2F1EF',
  selFill: 'rgba(21,75,212,0.12)',
  idleFill: '#F1F1F0',
  track: '#E8E7E4',
  error: '#D70015',
  hairline: 'rgba(0,0,0,0.06)',
  fieldHairline: 'rgba(0,0,0,0.10)',
  edgeShadow: 'inset 0px 1px 0px rgba(255,255,255,0.7), 0px 2px 10px rgba(15,23,42,0.06)',
};

/** The glass edge: a hairline, an inner top highlight and a soft lift, on white. */
export const edge: ViewStyle = {
  backgroundColor: home.surface,
  borderWidth: 1,
  borderColor: look.hairline,
  boxShadow: look.edgeShadow,
};

/** White card with the glass edge. */
export const edgeCard: ViewStyle = { ...edge, borderRadius: 16, overflow: 'hidden' };

/** A text field: corners 12 and a slightly darker hairline. */
export const edgeField: ViewStyle = { ...edge, borderRadius: 12, borderColor: look.fieldHairline };

export const sectionLabel: TextStyle = {
  fontSize: 11,
  lineHeight: 16,
  fontWeight: '500',
  color: home.tertiary,
  letterSpacing: 0.66,
  textTransform: 'uppercase',
};

/** Body copy on the canvas (an intro above a card). */
export const bodyText: TextStyle = { fontSize: 16, lineHeight: 21, color: home.text };
