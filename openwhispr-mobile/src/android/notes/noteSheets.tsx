import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/ui/Text';
import { SystemIcon } from '@/components/ui/SystemIcon';
import type { Action } from '@/android/shared/data';
import { BottomSheet, Toggle } from '../settings/kit';
import { GlassButton, OutlineButton } from '../processingFable/look';
import { Card, Chip, ListRow, SectionLabel, useNotesLook } from './look';
import { BUILT_IN_TEMPLATES } from './templates';
import { useNotesT } from './strings';

/** E4: the templates as radio rows; Rewrite summary waits until another one is picked. */
export function TemplateSheet({
  visible,
  onClose,
  current,
  actions,
  hasSummary,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  current: string;
  actions: Action[];
  hasSummary: boolean;
  onPick: (key: string) => void;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  const [picked, setPicked] = useState(current);
  useEffect(() => {
    if (visible) setPicked(current);
  }, [visible, current]);
  const own = actions.filter((action) => !action.isDefault);
  const rows = [
    ...BUILT_IN_TEMPLATES.map((template) => ({
      key: template.key,
      name: template.name,
      description: template.description,
    })),
    ...own.map((action) => ({
      key: `action:${action.id}`,
      name: action.name,
      description: action.description,
    })),
  ];
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('writeSummaryAs')}>
      <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ paddingVertical: 2 }}>
        <Card>
          {rows.map((row) => {
            const selected = row.key === picked;
            return (
              <Pressable
                key={row.key}
                cssInterop={false}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => setPicked(row.key)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingLeft: 16,
                  paddingRight: 14,
                  paddingVertical: 12,
                  minHeight: 64,
                  backgroundColor: selected ? n.selectedRow : 'transparent',
                }}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={n.rowTitle}>{row.name}</Text>
                  {row.description ? <Text style={n.rowSub}>{row.description}</Text> : null}
                </View>
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
                    borderWidth: selected ? 6 : 1.5,
                    borderColor: selected
                      ? n.accent
                      : n.theme.scheme === 'dark'
                        ? 'rgba(255,255,255,0.3)'
                        : 'rgba(0,0,0,0.25)',
                    backgroundColor: n.surface,
                  }}
                />
              </Pressable>
            );
          })}
        </Card>
      </ScrollView>
      <Text style={{ fontSize: 13, lineHeight: 18, color: n.secondary }}>
        {t('templatesFooter')}
      </Text>
      <GlassButton
        label={t(hasSummary ? 'rewriteSummary' : 'writeSummary')}
        disabled={hasSummary && picked === current}
        onPress={() => onPick(picked)}
      />
    </BottomSheet>
  );
}

/** E6, the ⋯ sheet: get it out, keep it, and Delete in red on its own. */
export function NoteMenuSheet({
  visible,
  onClose,
  title,
  folderName,
  backedUp,
  canBackUp,
  hasSummary,
  onShare,
  onExport,
  onCopySummary,
  onMove,
  onBackUp,
  onDelete,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  folderName: string | null;
  backedUp: boolean;
  canBackUp: boolean;
  hasSummary: boolean;
  onShare: () => void;
  onExport: () => void;
  onCopySummary: () => void;
  onMove?: () => void;
  onBackUp: (value: boolean) => void;
  onDelete: () => void;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={title}>
      <Card>
        <ListRow
          icon="Share"
          iconColor={n.text}
          title={t('shareNote')}
          subtitle={t('linkAndPeople')}
          chevron={false}
          onPress={onShare}
        />
        <ListRow
          icon="Download"
          iconColor={n.text}
          title={t('export')}
          subtitle={t('exportBody')}
          chevron={false}
          onPress={onExport}
        />
        {hasSummary ? (
          <ListRow
            icon="Copy"
            iconColor={n.text}
            title={t('copySummary')}
            chevron={false}
            onPress={onCopySummary}
          />
        ) : null}
      </Card>
      <Card>
        {onMove ? (
          <ListRow
            icon="Folder"
            iconColor={n.text}
            title={t('moveToFolder')}
            right={
              folderName ? (
                <Text numberOfLines={1} style={[n.count, { maxWidth: 140 }]}>
                  {folderName}
                </Text>
              ) : undefined
            }
            chevron={false}
            onPress={onMove}
          />
        ) : null}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingLeft: 14,
            paddingRight: 14,
            paddingVertical: 12,
            minHeight: 60,
          }}
        >
          <View
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              backgroundColor: n.idleFill,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <SystemIcon name="icloud" mdName="Cloud" size={20} color={n.text} />
          </View>
          <Text style={[n.rowTitle, { flex: 1 }]}>{t('backUpNote')}</Text>
          <Toggle
            value={backedUp}
            disabled={!canBackUp}
            onValueChange={onBackUp}
            label={t('backUpNote')}
          />
        </View>
      </Card>
      <Card>
        <ListRow
          icon="Trash2"
          destructive
          title={t('deleteNote')}
          chevron={false}
          onPress={onDelete}
        />
      </Card>
    </BottomSheet>
  );
}

export type ExportPart = 'summary' | 'notes' | 'transcript';

/** E7: the link and people on top (one tap deeper, as today), export underneath. */
export function ShareExportSheet({
  visible,
  onClose,
  parts,
  linkRow,
  onPeople,
  onSend,
  onSaveMarkdown,
}: {
  visible: boolean;
  onClose: () => void;
  parts: ExportPart[];
  linkRow: {
    title: string;
    subtitle: string;
    action?: { label: string; onPress: () => void };
    onPress: () => void;
  };
  onPeople?: () => void;
  onSend: (parts: ExportPart[]) => void;
  onSaveMarkdown: (parts: ExportPart[]) => void;
}) {
  const t = useNotesT();
  const n = useNotesLook();
  const [picked, setPicked] = useState<ExportPart[]>(parts.slice(0, 2));
  useEffect(() => {
    if (visible) setPicked(parts.slice(0, 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const toggle = (part: ExportPart) =>
    setPicked((current) =>
      current.includes(part)
        ? current.length > 1
          ? current.filter((value) => value !== part)
          : current
        : [...current, part],
    );
  const label: Record<ExportPart, string> = {
    summary: t('summary'),
    notes: t('myNotes'),
    transcript: t('transcript'),
  };
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('shareNote')}>
      <Card>
        <ListRow
          icon="Link"
          iconColor={n.text}
          title={linkRow.title}
          subtitle={linkRow.subtitle}
          chevron={!linkRow.action}
          onPress={linkRow.onPress}
          right={
            linkRow.action ? (
              <Pressable
                cssInterop={false}
                accessibilityRole="button"
                onPress={linkRow.action.onPress}
                hitSlop={8}
                style={({ pressed }) => ({ paddingHorizontal: 4, opacity: pressed ? 0.6 : 1 })}
              >
                <Text style={{ color: n.accent, fontSize: 16, fontWeight: '600' }}>
                  {linkRow.action.label}
                </Text>
              </Pressable>
            ) : undefined
          }
        />
        {onPeople ? (
          <ListRow
            icon="Users"
            iconColor={n.text}
            title={t('peopleWithAccess')}
            subtitle={t('peopleBody')}
            onPress={onPeople}
          />
        ) : null}
      </Card>
      <SectionLabel label={t('exportLabel')} />
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        {parts.map((part) => (
          <Chip
            key={part}
            label={label[part]}
            selected={picked.includes(part)}
            onPress={() => toggle(part)}
          />
        ))}
      </View>
      <Card>
        <ListRow
          icon="Share"
          iconColor={n.text}
          title={t('sendToApp')}
          subtitle={t('sendToAppBody')}
          chevron={false}
          onPress={() => onSend(picked)}
        />
        <ListRow
          icon="FileText"
          iconColor={n.text}
          title={t('saveMarkdown')}
          subtitle={t('saveMarkdownBody')}
          chevron={false}
          onPress={() => onSaveMarkdown(picked)}
        />
      </Card>
    </BottomSheet>
  );
}

/** A1: the privacy question as a sheet, with the other way out (download a text model). */
export function CloudOnceSheet({
  visible,
  onClose,
  body,
  onUseCloud,
  onDownload,
}: {
  visible: boolean;
  onClose: () => void;
  body: string;
  onUseCloud: () => void;
  onDownload?: () => void;
}) {
  const t = useNotesT();
  return (
    <BottomSheet visible={visible} onClose={onClose} title={t('cloudTitle')} body={body}>
      <View style={{ gap: 10 }}>
        <GlassButton label={t('useCloudOnce')} onPress={onUseCloud} />
        {onDownload ? <OutlineButton label={t('downloadTextModel')} onPress={onDownload} /> : null}
      </View>
    </BottomSheet>
  );
}
