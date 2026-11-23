import React from 'react';
import { Text, type TextStyle } from 'react-native';
import { AppFont } from '@/lib/fonts';
import { home } from '../home/kit';
import { liveMarkdownSpans, type LiveSpan } from './liveMarkdownSpans';

const HEADING_SIZE = { 1: 22, 2: 19, 3: 17 } as const;

function spanStyle(span: LiveSpan): TextStyle {
  const style: TextStyle = {};
  if (span.heading) {
    style.fontSize = HEADING_SIZE[span.heading];
    style.fontFamily = AppFont.semibold;
  }
  switch (span.kind) {
    case 'mark':
      style.color = home.tertiary;
      break;
    case 'bold':
      style.fontFamily = AppFont.semibold;
      break;
    case 'italic':
      style.fontStyle = 'italic';
      break;
    case 'boldItalic':
      style.fontFamily = AppFont.semibold;
      style.fontStyle = 'italic';
      break;
    case 'code':
      style.fontFamily = 'monospace';
      style.fontSize = 15;
      break;
    default:
      break;
  }
  return style;
}

/** The styled children for a TextInput showing `text`; pass them in place of `value`. */
export function LiveMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {liveMarkdownSpans(text).map((span, index) => (
        <Text key={index} style={spanStyle(span)}>
          {span.text}
        </Text>
      ))}
    </>
  );
}
