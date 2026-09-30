import { Platform } from 'react-native';
import {
  getTrackingPermissionsAsync,
  isAvailable,
  requestTrackingPermissionsAsync,
  type PermissionResponse,
} from 'expo-tracking-transparency';

export type TrackingAuthorizationStatus =
  | 'authorized'
  | 'denied'
  | 'notDetermined'
  | 'notSupported';

function mapPermissionStatus(
  status: PermissionResponse['status'],
): Exclude<TrackingAuthorizationStatus, 'notSupported'> {
  if (status === 'granted') return 'authorized';
  if (status === 'denied') return 'denied';
  return 'notDetermined';
}

export async function getTrackingAuthorizationStatus(): Promise<TrackingAuthorizationStatus> {
  if (Platform.OS !== 'ios' || !isAvailable()) return 'notSupported';
  const response = await getTrackingPermissionsAsync();
  return mapPermissionStatus(response.status);
}

export async function requestTrackingAuthorization(): Promise<TrackingAuthorizationStatus> {
  if (Platform.OS !== 'ios' || !isAvailable()) return 'notSupported';
  const response = await requestTrackingPermissionsAsync();
  return mapPermissionStatus(response.status);
}
