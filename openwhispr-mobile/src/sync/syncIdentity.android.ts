const upstream = require('./syncIdentity.ts') as typeof import('./syncIdentity');

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
