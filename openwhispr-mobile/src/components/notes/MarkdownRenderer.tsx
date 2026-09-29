import { useMemo } from 'react';
import {
  View,
  PlatformColor,
  ScrollView,
  StyleSheet,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import { Text } from '@/components/ui/Text';
import { parseMarkdownBlocks, type MarkdownBlock } from './markdownBlocks';
import { NOTES_GROUP_RADIUS } from './tokens';

interface MarkdownRendererProps {
  content: string;
  selectable?: boolean;
}

const labelColor = PlatformColor('label') as unknown as string;
const secondaryColor = PlatformColor('secondaryLabel') as unknown as string;
const tertiaryBg = PlatformColor('tertiarySystemBackground') as unknown as string;

type InlineSegment = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

function parseInline(text: string): InlineSegment[] {
  const segments: InlineSegment[] = [];
  const regex = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    if (raw.startsWith('`')) {
      segments.push({ text: raw.slice(1, -1), code: true });
    } else if (raw.startsWith('**')) {
      segments.push({ text: raw.slice(2, -2), bold: true });
    } else if (raw.startsWith('*')) {
      segments.push({ text: raw.slice(1, -1), italic: true });
    }
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ text }];
}

function InlineText({
  segments,
  selectable = false,
  style,
}: {
  segments: InlineSegment[];
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      selectable={selectable}
      style={[{ fontSize: 16, lineHeight: 24, color: labelColor }, style]}
    >
      {segments.map((seg, i) => {
        if (seg.code) {
          return (
            <Text
              key={i}
              style={{
                fontFamily: 'Menlo',
                fontSize: 14,
                backgroundColor: tertiaryBg,
                color: labelColor,
              }}
            >
              {' '}
              {seg.text}{' '}
            </Text>
          );
        }
        return (
          <Text
            key={i}
            style={{
              fontWeight: seg.bold ? '600' : undefined,
              fontStyle: seg.italic ? 'italic' : undefined,
            }}
          >
            {seg.text}
          </Text>
        );
      })}
    </Text>
  );
}

// Sized from the longest cell so no measuring pass is needed; wide tables
// scroll sideways rather than squeezing every column into the screen.
const CELL_CHAR_WIDTH = 8;
const CELL_PADDING = 20;
const MIN_COLUMN_WIDTH = 80;
const MAX_COLUMN_WIDTH = 220;

type TableBlock = Extract<MarkdownBlock, { type: 'table' }>;

function columnWidths(table: TableBlock): number[] {
  return table.header.map((label, column) => {
    const longest = Math.max(label.length, ...table.rows.map((row) => row[column].length));
    const width = longest * CELL_CHAR_WIDTH + CELL_PADDING;
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width));
  });
}

function MarkdownTable({ table, selectable }: { table: TableBlock; selectable: boolean }) {
  const widths = columnWidths(table);
  const allRows = [table.header, ...table.rows];

  return (
    <ScrollView
      testID="markdown-table"
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.tableScroller}
    >
      <View className="overflow-hidden border-separator" style={styles.table}>
        {allRows.map((row, rowIndex) => {
          const isHeader = rowIndex === 0;
          return (
            <View
              key={rowIndex}
              className={`flex-row border-separator ${isHeader ? 'bg-secondarySystemBackground' : ''}`}
              style={!isHeader && styles.rowDivider}
            >
              {row.map((cell, column) => {
                const width = widths[column];
                const textAlign = table.alignments[column] ?? 'auto';
                return (
                  <View
                    key={column}
                    className="border-separator px-2.5 py-1.5"
                    style={[{ width }, column > 0 && styles.cellDivider]}
                  >
                    <InlineText
                      segments={parseInline(cell)}
                      selectable={selectable}
                      style={[styles.cellText, isHeader && styles.headerCellText, { textAlign }]}
                    />
                  </View>
                );
              })}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

export function MarkdownRenderer({ content, selectable = false }: MarkdownRendererProps) {
  const elements = useMemo(() => parseMarkdownBlocks(content), [content]);

  return (
    <View style={{ gap: 2 }}>
      {elements.map((el, i) => {
        if (el.type === 'empty') {
          return <View key={i} style={{ height: 12 }} />;
        }

        if (el.type === 'rule') {
          return (
            <View
              key={i}
              testID="markdown-rule"
              className="my-2.5 bg-separator"
              style={styles.rule}
            />
          );
        }

        if (el.type === 'table') {
          return <MarkdownTable key={i} table={el} selectable={selectable} />;
        }

        if (el.type === 'h1') {
          return (
            <Text
              key={i}
              accessibilityRole="header"
              selectable={selectable}
              style={{
                fontSize: 22,
                fontWeight: '700',
                color: labelColor,
                marginTop: 8,
                marginBottom: 4,
              }}
            >
              {el.content}
            </Text>
          );
        }

        if (el.type === 'h2') {
          return (
            <Text
              key={i}
              accessibilityRole="header"
              selectable={selectable}
              style={{
                fontSize: 18,
                fontWeight: '600',
                color: labelColor,
                marginTop: 6,
                marginBottom: 3,
              }}
            >
              {el.content}
            </Text>
          );
        }

        if (el.type === 'h3') {
          return (
            <Text
              key={i}
              accessibilityRole="header"
              selectable={selectable}
              style={{
                fontSize: 16,
                fontWeight: '600',
                color: labelColor,
                marginTop: 4,
                marginBottom: 2,
              }}
            >
              {el.content}
            </Text>
          );
        }

        if (el.type === 'bullet') {
          return (
            <View key={i} style={{ flexDirection: 'row', paddingLeft: 8, gap: 6 }}>
              <Text style={{ fontSize: 16, color: secondaryColor, lineHeight: 24 }}>
                {'\u2022'}
              </Text>
              <View style={{ flex: 1 }}>
                <InlineText segments={parseInline(el.content)} selectable={selectable} />
              </View>
            </View>
          );
        }

        if (el.type === 'numbered') {
          return (
            <View key={i} style={{ flexDirection: 'row', paddingLeft: 8, gap: 6 }}>
              <Text
                style={{
                  fontSize: 16,
                  color: secondaryColor,
                  lineHeight: 24,
                  minWidth: 18,
                  textAlign: 'right',
                }}
              >
                {el.number}.
              </Text>
              <View style={{ flex: 1 }}>
                <InlineText segments={parseInline(el.content)} selectable={selectable} />
              </View>
            </View>
          );
        }

        return (
          <View key={i}>
            <InlineText segments={parseInline(el.content)} selectable={selectable} />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  // A horizontal ScrollView defaults to flexGrow: 1 and would stretch to any
  // free height in its column, like the note chat sheet's.
  tableScroller: { flexGrow: 0, marginVertical: 6 },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: NOTES_GROUP_RADIUS,
    borderCurve: 'continuous',
  },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth },
  cellDivider: { borderLeftWidth: StyleSheet.hairlineWidth },
  cellText: { fontSize: 15, lineHeight: 20 },
  headerCellText: { fontWeight: '600' },
  rule: { height: StyleSheet.hairlineWidth },
});
