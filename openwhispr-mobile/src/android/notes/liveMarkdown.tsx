import React from 'react';
import { Pressable, Text, View, type TextStyle } from 'react-native';
import { SystemIcon } from '@/components/ui/SystemIcon';
import { AppFont } from '@/lib/fonts';
import { home } from '../home/kit';
import { lineAt, parseNoteLines, type LiveSpan, type NoteLine } from './liveMarkdownSpans';

const BODY = { fontFamily: AppFont.regular, fontSize: 16, lineHeight: 26, color: home.text };
const HEADING_SIZE = { 1: 22, 2: 19, 3: 17 } as const;
// Every list marker sits in the same column, so bullet, checkbox and number text line up.
const MARKER = { width: 22, height: 26, alignItems: 'center', justifyContent: 'center' } as const;
// A mark off the caret's line takes no room: it stays in the text (so offsets, the caret and
// what's saved are unchanged) but draws at a pixel's height in no colour.
const HIDDEN: TextStyle = { fontSize: 0.1, color: 'transparent' };

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
    case 'mention':
      style.color = home.accent;
      style.fontFamily = AppFont.medium;
      break;
    default:
      break;
  }
  return style;
}

/**
 * The styled children for the notes TextInput; pass them in place of `value`. The caret's line
 * shows its marks, faded, so they can be edited; every other line hides its bold, italic and
 * heading marks and keeps only the list marks that say it's a list.
 */
export function LiveMarkdown({ text, caret }: { text: string; caret: number }): React.JSX.Element {
  const caretLine = lineAt(text, caret);
  const lines = parseNoteLines(text);
  const pieces: React.JSX.Element[] = [];
  lines.forEach((line, index) => {
    const onCaretLine = index === caretLine;
    if (line.mark) {
      const mark: LiveSpan = { text: line.mark, kind: 'mark', heading: line.heading };
      const style = line.kind === 'heading' && !onCaretLine ? HIDDEN : spanStyle(mark);
      pieces.push(
        <Text key={`${index}m`} style={style}>
          {line.mark}
        </Text>,
      );
    }
    line.inline.forEach((span, spanIndex) => {
      const hidden = span.kind === 'mark' && !onCaretLine;
      pieces.push(
        <Text key={`${index}-${spanIndex}`} style={hidden ? HIDDEN : spanStyle(span)}>
          {span.text}
        </Text>,
      );
    });
    if (index < lines.length - 1) pieces.push(<Text key={`${index}n`}>{'\n'}</Text>);
  });
  return <>{pieces}</>;
}

function Inline({ line, style }: { line: NoteLine; style?: TextStyle }) {
  return (
    <Text style={[BODY, style]}>
      {line.inline
        .filter((span) => span.kind !== 'mark')
        .map((span, index) => (
          <Text key={index} style={spanStyle(span)}>
            {span.text}
          </Text>
        ))}
    </Text>
  );
}

const plainText = (line: NoteLine) =>
  line.inline
    .filter((span) => span.kind !== 'mark')
    .map((span) => span.text)
    .join('');

/**
 * The notes as formatted text, with no Markdown marks: headings, bullets, checkboxes, bold and
 * italics. Tapping a line edits the notes with the caret at that line's end; tapping a checkbox
 * ticks it.
 */
export function NotesReadView({
  text,
  editable,
  onEdit,
  onToggle,
}: {
  text: string;
  editable: boolean;
  onEdit: (caret: number) => void;
  onToggle: (line: NoteLine) => void;
}): React.JSX.Element {
  const lines = parseNoteLines(text);
  return (
    <View testID="note-content-read" style={{ minHeight: 160 }}>
      {lines.map((line, index) => {
        const end = line.start + line.text.length;
        let body: React.ReactNode;
        if (!line.text.trim()) {
          body = <View style={{ height: 26 }} />;
        } else if (line.kind === 'heading' && line.heading) {
          body = (
            <Inline
              line={line}
              style={{
                fontFamily: AppFont.semibold,
                fontSize: HEADING_SIZE[line.heading],
                lineHeight: HEADING_SIZE[line.heading] + 10,
              }}
            />
          );
        } else if (line.kind === 'plain') {
          body = <Inline line={line} />;
        } else {
          const marker =
            line.kind === 'check' ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: !!line.checked, disabled: !editable }}
                accessibilityLabel={plainText(line)}
                disabled={!editable}
                hitSlop={8}
                onPress={() => onToggle(line)}
                style={MARKER}
              >
                <SystemIcon
                  name={line.checked ? 'checkmark.square' : 'square'}
                  mdName={line.checked ? 'SquareCheck' : 'Square'}
                  size={18}
                  color={line.checked ? home.accent : home.secondary}
                />
              </Pressable>
            ) : (
              <View style={MARKER}>
                <Text
                  style={[
                    BODY,
                    { color: home.secondary },
                    line.kind === 'bullet' && { fontSize: 22, lineHeight: 26 },
                  ]}
                >
                  {line.kind === 'bullet' ? '\u2022' : line.mark.trim()}
                </Text>
              </View>
            );
          body = (
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {marker}
              <View style={{ flex: 1 }}>
                <Inline
                  line={line}
                  style={
                    line.checked
                      ? { color: home.secondary, textDecorationLine: 'line-through' }
                      : undefined
                  }
                />
              </View>
            </View>
          );
        }
        return (
          <Pressable key={index} disabled={!editable} onPress={() => onEdit(end)}>
            {body}
          </Pressable>
        );
      })}
      {editable ? (
        <Pressable
          testID="note-content-edit"
          accessible={false}
          style={{ flexGrow: 1, minHeight: 40 }}
          onPress={() => onEdit(text.length)}
        />
      ) : null}
    </View>
  );
}
