import React from 'react';
import { Switch, type SwitchProps } from 'react-native';
import { iosColor } from '@/config/colors';

const SWITCH_TRACK_ON = iosColor('systemGreen');

export function SettingsSwitch(props: SwitchProps) {
  return <Switch trackColor={{ true: SWITCH_TRACK_ON, false: undefined }} {...props} />;
}
