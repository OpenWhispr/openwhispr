import React from 'react';
import { ScrollView, StyleSheet, type ScrollViewProps } from 'react-native';

type Props = ScrollViewProps & {
  children: React.ReactNode;
};

export function SettingsScreen({ children, contentContainerStyle, ...rest }: Props) {
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="bg-systemBackground"
      contentContainerStyle={[styles.content, contentContainerStyle]}
      {...rest}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingBottom: 40,
    paddingTop: 8,
  },
});
