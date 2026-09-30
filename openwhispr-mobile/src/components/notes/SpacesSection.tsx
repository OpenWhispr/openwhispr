import { useMemo } from 'react';
import { View } from 'react-native';
import { GroupedList } from './GroupedList';
import { SectionHeader } from './SectionHeader';
import { SpaceRow } from './SpaceRow';
import type { Space } from '@/data';

type SpacesSectionProps = {
  /** Team spaces only — pass an empty array (or none) when the account has no team spaces, in
   * which case this renders nothing: personal-only users see zero visual change. */
  spaces: Space[];
  onSelect: (spaceId: number) => void;
};

type WorkspaceGroup = {
  key: string;
  label: string;
  spaces: Space[];
};

/**
 * One group per workspace, so spaces belonging to different workspaces are never
 * listed as one flat run. Falls back to a plain "Spaces" heading for any space
 * whose workspace name hasn't been mirrored yet (a backend without
 * /api/workspaces, or a sync pass whose name fetch failed).
 */
function groupByWorkspace(spaces: Space[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>();
  for (const space of spaces) {
    const key = space.workspaceId ?? '';
    const group = groups.get(key);
    if (group) {
      group.spaces.push(space);
    } else {
      groups.set(key, { key, label: space.workspaceName ?? 'Spaces', spaces: [space] });
    }
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function SpacesSection({ spaces, onSelect }: SpacesSectionProps) {
  const groups = useMemo(() => groupByWorkspace(spaces), [spaces]);

  if (spaces.length === 0) return null;

  return (
    <View>
      {groups.map((group) => (
        <View key={group.key}>
          <SectionHeader label={group.label} />
          <GroupedList>
            {group.spaces.map((space) => (
              <SpaceRow key={space.id} space={space} onPress={() => onSelect(space.id)} />
            ))}
          </GroupedList>
        </View>
      ))}
    </View>
  );
}
