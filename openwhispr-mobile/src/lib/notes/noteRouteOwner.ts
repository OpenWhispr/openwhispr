import { Platform } from 'react-native';

export function getNotesRouteOwner(): string | undefined {
  if (Platform.OS !== 'android') return undefined;
  const { useAccountData } =
    require('@/android/accountData') as typeof import('@/android/accountData');
  return useAccountData.getState().owner ?? undefined;
}

export function withNotesRouteOwner(params: { folderId?: string; spaceId?: string }) {
  const dataOwner = getNotesRouteOwner();
  return dataOwner === undefined ? params : { ...params, dataOwner };
}
