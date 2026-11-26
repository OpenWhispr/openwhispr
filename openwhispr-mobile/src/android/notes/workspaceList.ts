import { useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { fetchMyWorkspaces } from '@/data/remote/workspacesApi';
import { useAuthStore } from '@/android/store/useAuthStore';
import { useKnownWorkspaces } from './library';

/**
 * Reads every workspace you belong to each time the Notes home comes into view (Figma W2). A
 * failed or unavailable request keeps the last list, and the teamspaces still name the rest.
 */
export function useLoadWorkspaces() {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  useFocusEffect(
    useCallback(() => {
      if (!userId) return;
      let current = true;
      fetchMyWorkspaces()
        .then(({ data }) => {
          if (!current || useAuthStore.getState().user?.id !== userId) return;
          useKnownWorkspaces.setState({
            owner: userId,
            list: data
              .filter((workspace) => workspace?.id)
              .map((workspace) => ({ id: workspace.id, name: workspace.name ?? '' })),
          });
        })
        .catch(() => undefined);
      return () => {
        current = false;
      };
    }, [userId]),
  );
}
