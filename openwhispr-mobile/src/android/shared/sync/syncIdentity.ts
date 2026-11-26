const upstream =
  require('@/android/shared/sync/syncIdentityBase') as typeof import('@/android/shared/sync/syncIdentityBase');

export const {
  getLastSyncedUserId,
  setLastSyncedUserId,
  recordAnonymousUser,
  isLinkFromAnonymous,
  clearAnonymousLink,
} = upstream;

export function hasRealAccountHistory(): boolean {
  const { hasAndroidAccountHistory } =
    require('@/android/accountData') as typeof import('@/android/accountData');
  return hasAndroidAccountHistory();
}
