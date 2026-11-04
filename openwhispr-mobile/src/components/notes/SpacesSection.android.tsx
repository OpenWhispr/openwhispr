import { useMemo } from 'react';
import { useAndroidCopy } from '@/hooks/useAndroidCopy';
import { createSpacesSection, groupByWorkspace } from './SpacesSectionCore';

export const SpacesSection = createSpacesSection(function useWorkspaceGroups(spaces) {
  const { copy } = useAndroidCopy();
  const fallbackLabel = copy('library.spaces', 'Spaces');
  return useMemo(() => groupByWorkspace(spaces, fallbackLabel), [spaces, fallbackLabel]);
});
