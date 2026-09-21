import { useMemo } from 'react';
import { View, PlatformColor } from 'react-native';
import { Text } from '@/components/ui/Text';

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
}: {
  segments: InlineSegment[];
  selectable?: boolean;
}) {
  return (
    <Text selectable={selectable} style={{ fontSize: 16, lineHeight: 24, color: labelColor }}>
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

interface ParsedLine {
  type: 'h1' | 'h2' | 'h3' | 'bullet' | 'numbered' | 'paragraph' | 'empty';
  content: string;
  number?: number;
}

function parseLine(line: string): ParsedLine {
  if (line.trim() === '') return { type: 'empty', content: '' };
  if (line.startsWith('### ')) return { type: 'h3', content: line.slice(4) };
  if (line.startsWith('## ')) return { type: 'h2', content: line.slice(3) };
  if (line.startsWith('# ')) return { type: 'h1', content: line.slice(2) };

  const bulletMatch = line.match(/^[-*]\s+(.*)/);
  if (bulletMatch) return { type: 'bullet', content: bulletMatch[1] };

  const numberedMatch = line.match(/^(\d+)\.\s+(.*)/);
  if (numberedMatch)
    return { type: 'numbered', content: numberedMatch[2], number: parseInt(numberedMatch[1], 10) };

  return { type: 'paragraph', content: line };
}

export function MarkdownRenderer({ content, selectable = false }: MarkdownRendererProps) {
  const elements = useMemo(() => {
    const lines = content.split('\n');
    return lines.map((line) => parseLine(line));
  }, [content]);

  return (
    <View style={{ gap: 2 }}>
      {elements.map((el, i) => {
        if (el.type === 'empty') {
          return <View key={i} style={{ height: 12 }} />;
        }

        if (el.type === 'h1') {
          return (
            <Text
              key={i}
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
